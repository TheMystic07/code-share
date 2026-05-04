import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Proxy } from "http-mitm-proxy";

import { getSession } from "../session/manager.js";
import { writeDevLog, truncate, LOG_FILE, type DevLogEntry } from "./devLogger.js";
import { logRequest, setResponseStatus } from "./requestLog.js";
import { getAccessToken } from "./token.js";

const IS_DEV = process.env.NODE_ENV === "development";

// Per-request log id stored on ctx so onResponse can update it
const CTX_LOG_ID = Symbol("logId");

// Dev-mode: full request/response entry and raw body chunks
const DEV_ENTRY = Symbol("devEntry");
const DEV_CHUNKS = Symbol("devChunks");

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
      if (allowed.method === null || allowed.method === method.toUpperCase()) return true;
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
  close(): void;
}

/**
 * Starts the MITM proxy on a random localhost port.
 * Resolves only after the RSA CA is ready so CONNECT handling never races.
 */
export async function createMitmProxy(connectionId?: string): Promise<MitmProxy> {
  const sslCaDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-share-mitm-"));

  return new Promise<MitmProxy>((resolve, reject) => {
    let proxyPort = 0;
    let proxyReady = false;
    const pendingSockets: net.Socket[] = [];

    const proxy = new Proxy();
    proxy.use(Proxy.gunzip);

    proxy.onError((ctx: any, err: any) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error("[mitm] error:", err.message);
      }
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
        ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }

      if (hostname === "api.anthropic.com" && !isApiAllowed(method, reqPath)) {
        logRequest(method, hostname, reqPath, "blocked");
        if (IS_DEV) {
          writeDevLog({
            ts: new Date().toISOString(),
            outcome: "BLOCKED",
            method,
            host: hostname,
            path: reqPath,
            requestHeaders: ctx.clientToProxyRequest.headers,
            requestBody: "",
            httpStatus: null,
            responseHeaders: null,
          });
        }
        ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }
      if (hostname === "platform.anthropic.com" && !isPlatformAnthropicAllowed(reqPath)) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }
      if (hostname === "platform.claude.com" && !isPlatformClaudeAllowed(reqPath)) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }

      ctx[CTX_LOG_ID] = logRequest(method, hostname, reqPath, "allowed");

      ctx.proxyToServerRequestOptions.headers = ctx.proxyToServerRequestOptions.headers ?? {};
      ctx.proxyToServerRequestOptions.headers["authorization"] = `Bearer ${getAccessToken()}`;

      delete ctx.proxyToServerRequestOptions.headers["x-forwarded-for"];
      delete ctx.proxyToServerRequestOptions.headers["x-real-ip"];


      if (IS_DEV && hostname === "api.anthropic.com") {
        ctx[DEV_ENTRY] = {
          ts: new Date().toISOString(),
          outcome: "INTERCEPTED",
          method,
          host: hostname,
          path: reqPath,
          requestHeaders: ctx.clientToProxyRequest.headers,
          requestBody: "",
          httpStatus: null,
          responseHeaders: null,
        } satisfies DevLogEntry;
        ctx[DEV_CHUNKS] = [] as Buffer[];
      }

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

      if (IS_DEV && ctx[DEV_ENTRY]) {
        ctx[DEV_ENTRY].httpStatus = ctx.serverToProxyResponse.statusCode ?? null;
        ctx[DEV_ENTRY].responseHeaders = respHeaders ?? null;
      }
      callback();
    });

    if (IS_DEV) {
      console.log(`[dev] logging requests to ${LOG_FILE}`);

      proxy.onRequestData(
        (ctx: any, chunk: Buffer, callback: (err: null, chunk: Buffer) => void) => {
          if (ctx[DEV_CHUNKS]) ctx[DEV_CHUNKS].push(chunk);
          callback(null, chunk);
        },
      );

      proxy.onRequestEnd((ctx: any, callback: () => void) => {
        const entry: DevLogEntry | undefined = ctx[DEV_ENTRY];
        if (entry) {
          const chunks: Buffer[] = ctx[DEV_CHUNKS] ?? [];
          entry.requestBody = truncate(Buffer.concat(chunks));
          writeDevLog(entry);
        }
        callback();
      });
    }

    proxy.onConnect((_req: any, _socket: any, _head: any, callback: () => void) => {
      callback();
    });

    // Listen on a random localhost port — CA generation completes before callback fires
    proxy.listen({ port: 0, host: "127.0.0.1", sslCaDir }, (err?: Error | null) => {
      if (err) return reject(err);
      try {
        proxyPort = (proxy as any).httpServer.address().port;
        proxyReady = true;
        const caCertPem = fs.readFileSync(path.join(sslCaDir, "certs", "ca.pem"), "utf8");

        for (const s of pendingSockets) pipeToProxy(s);
        pendingSockets.length = 0;

        resolve({
          caCertPem,
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
      } catch (readErr) {
        reject(readErr);
      }
    });

    function pipeToProxy(socket: net.Socket) {
      const upstream = net.connect(proxyPort, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    }
  });
}
