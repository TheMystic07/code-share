import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Proxy } from "http-mitm-proxy";

import { generateServerCert, type ServerCert } from "../ca/serverCert";
import { logger } from "../logger";
import { logRequest, setResponseStatus } from "./requestLog";
import { getAccessToken } from "./token";

// Per-request log id stored on ctx so onResponse can update it
const CTX_LOG_ID = Symbol("logId");

// Domains the proxy intercepts and forwards to Anthropic with injected token
const INTERCEPT_DOMAINS = new Set([
  "api.anthropic.com",
  "platform.anthropic.com",
  "platform.claude.com",
  "mcp-proxy.anthropic.com",
]);

// Domains allowed to pass through without interception or token injection
const PASSTHROUGH_DOMAINS = new Set(["raw.githubusercontent.com"]);

// api.anthropic.com allowed paths
const API_ALLOWED_PATHS: Array<{ method: string | null; prefix: string }> = [
  { method: null, prefix: "/api/hello" },
  { method: "POST", prefix: "/v1/messages" },
  { method: "GET", prefix: "/v1/models" },
];

// api.anthropic.com paths that are always blocked regardless of method
const API_BLOCKED_PREFIXES = ["/v1/files", "/v1/fine_tuning", "/v1/assistants"];

function isApiAllowed(method: string, reqPath: string): boolean {
  for (const blocked of API_BLOCKED_PREFIXES) {
    if (reqPath.startsWith(blocked)) return false;
  }
  for (const allowed of API_ALLOWED_PATHS) {
    if (reqPath.startsWith(allowed.prefix)) {
      if (allowed.method === null || allowed.method === method.toUpperCase())
        return true;
    }
  }
  return false;
}

// platform.anthropic.com allowed paths
function isPlatformAnthropicAllowed(reqPath: string): boolean {
  return reqPath.startsWith("/api/auth/");
}

// platform.claude.com allowed paths
function isPlatformClaudeAllowed(reqPath: string): boolean {
  return reqPath.startsWith("/v1/oauth/");
}

export interface MitmProxy {
  /** Feed a socket that has already been identified as a CONNECT request */
  handleSocket(socket: net.Socket): void;
  /** PEM of the CA cert that signs intercepted TLS connections */
  caCertPem: string;
  /** TLS server cert for the API port, signed by the MITM CA */
  serverCert: ServerCert;
  close(): void;
}

/**
 * Starts the MITM proxy on a random localhost port.
 * Resolves only after the RSA CA is ready so CONNECT handling never races.
 */
export async function createMitmProxy(
  lanIp: string | null = null,
  checkAuth: (authHeader: string) => boolean = () => false,
): Promise<MitmProxy> {
  const sslCaDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "claude-share-mitm-"),
  );

  return new Promise<MitmProxy>((resolve, reject) => {
    let proxyPort = 0;
    let proxyReady = false;
    const pendingSockets: net.Socket[] = [];

    const proxy = new Proxy();
    proxy.use(Proxy.gunzip);

    proxy.onError((ctx: any, err: any) => {
      if (!err) return;
      const code = (err as NodeJS.ErrnoException).code;
      // ECONNRESET and HPE_INVALID_EOF_STATE are benign keep-alive teardowns
      if (code === "ECONNRESET" || code === "HPE_INVALID_EOF_STATE") return;
      logger.error("[mitm] proxy error", err);
    });

    proxy.onRequest((ctx: any, callback: () => void) => {
      const host = ctx.clientToProxyRequest.headers.host ?? "";
      const hostname = host.split(":")[0];
      const method = ctx.clientToProxyRequest.method ?? "GET";
      const reqPath = ctx.clientToProxyRequest.url ?? "/";

      if (PASSTHROUGH_DOMAINS.has(hostname)) {
        return callback();
      }

      if (!INTERCEPT_DOMAINS.has(hostname)) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }

      if (hostname === "api.anthropic.com" && !isApiAllowed(method, reqPath)) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }
      if (
        hostname === "platform.anthropic.com" &&
        !isPlatformAnthropicAllowed(reqPath)
      ) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }
      if (
        hostname === "platform.claude.com" &&
        !isPlatformClaudeAllowed(reqPath)
      ) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }

      ctx[CTX_LOG_ID] = logRequest(method, hostname, reqPath, "allowed");

      ctx.proxyToServerRequestOptions.headers =
        ctx.proxyToServerRequestOptions.headers ?? {};
      ctx.proxyToServerRequestOptions.headers["authorization"] =
        `Bearer ${getAccessToken()}`;

      delete ctx.proxyToServerRequestOptions.headers["x-forwarded-for"];
      delete ctx.proxyToServerRequestOptions.headers["x-real-ip"];

      callback();
    });

    proxy.onResponse((ctx: any, callback: () => void) => {
      const logId = ctx[CTX_LOG_ID];
      if (logId !== undefined) {
        setResponseStatus(logId, ctx.serverToProxyResponse.statusCode ?? 0);
      }

      // Strip any response headers that could leak the sharer's credentials
      const respHeaders = ctx.serverToProxyResponse.headers;
      if (respHeaders) {
        delete respHeaders["authorization"];
        delete respHeaders["set-cookie"];
        delete respHeaders["x-api-key"];
      }

      callback();
    });

    proxy.onConnect(
      (req: any, socket: any, head: any, callback: () => void) => {
        const connectAuth = req.headers["proxy-authorization"] ?? "";
        if (!checkAuth(connectAuth)) {
          socket.write(
            "HTTP/1.1 407 Proxy Authentication Required\r\n" +
              'Proxy-Authenticate: Basic realm="claude-share"\r\n' +
              "Content-Length: 0\r\n" +
              "\r\n",
          );
          socket.destroy();
          return;
        }

        const [hostname, portStr] = ((req.url as string) ?? "").split(":");
        if (INTERCEPT_DOMAINS.has(hostname)) {
          callback();
          return;
        }
        // Non-Anthropic domain: transparent TCP tunnel — no cert, no decryption.
        // The client's TLS handshake goes straight to the real server.
        const port = parseInt(portStr, 10) || 443;
        const upstream = net.connect(port, hostname, () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head?.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      },
    );

    // Listen on a random localhost port — CA generation completes before callback fires
    proxy.listen(
      { port: 0, host: "127.0.0.1", sslCaDir },
      (err?: Error | null) => {
        if (err) return reject(err);

        (async () => {
          proxyPort = (proxy as any).httpServer.address().port;
          proxyReady = true;
          const caCertPem = fs.readFileSync(
            path.join(sslCaDir, "certs", "ca.pem"),
            "utf8",
          );
          const caKeyPem = fs.readFileSync(
            path.join(sslCaDir, "keys", "ca.private.key"),
            "utf8",
          );
          const serverCert = await generateServerCert(
            caCertPem,
            caKeyPem,
            lanIp,
          );

          for (const s of pendingSockets) pipeToProxy(s);
          pendingSockets.length = 0;

          resolve({
            caCertPem,
            serverCert,
            handleSocket(socket) {
              if (proxyReady) {
                pipeToProxy(socket);
              } else {
                pendingSockets.push(socket);
              }
            },
            close() {
              proxy.close();
              fs.rm(sslCaDir, { recursive: true, force: true }, () => {});
            },
          });
        })().catch(reject);
      },
    );

    function pipeToProxy(socket: net.Socket) {
      const upstream = net.connect(proxyPort, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    }
  });
}
