import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";

import { Proxy } from "http-mitm-proxy";

import { generateServerCert, type ServerCert } from "../ca/serverCert";
import { logger } from "../logger";
import type { ToolPolicy } from "./policy";
import { logRequest, setResponseStatus } from "./requestLog";
import { canRefresh, getAuthHeaders, onUpstreamUnauthorized } from "./token";

// Per-request log id stored on ctx so onResponse can update it
const CTX_LOG_ID = Symbol("logId");

// Domains allowed to pass through without interception or token injection
// (plain-HTTP proxy requests only; CONNECT to non-intercepted hosts is piped raw).
const PASSTHROUGH_DOMAINS = new Set(["raw.githubusercontent.com"]);

// ── Connection tuning ────────────────────────────────────────────────────────
// Long Opus turns can sit idle (from the client's point of view) for minutes.
// We keep every hop alive with TCP keepalive so a dead tunnel is detected in
// ~1 min instead of hanging forever, and we shorten Node's HTTP request
// timeouts so a half-uploaded request fails fast (Claude Code retries).
const TCP_KEEPALIVE_MS = 15_000;
/** Idle limit for a socket carrying an in-flight request/response. */
const SOCKET_IDLE_MS = 10 * 60 * 1000;

export function tuneSocket(socket: net.Socket): void {
  try {
    socket.setKeepAlive(true, TCP_KEEPALIVE_MS);
    socket.setNoDelay(true);
  } catch {}
}

function tuneServer(server: http.Server | https.Server): void {
  server.timeout = SOCKET_IDLE_MS;
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  // A client that hasn't finished uploading its request in 3 min is gone.
  server.requestTimeout = 180_000;
  server.on("connection", tuneSocket);
  (server as https.Server).on?.("secureConnection", tuneSocket);
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
 *
 * `certHosts` — every hostname / IP receivers may use to reach this machine.
 * `policy`    — which hosts to intercept and which requests to forward (per tool).
 */
export async function createMitmProxy(
  certHosts: { hostnames: string[]; ips: string[] },
  checkAuth: (authHeader: string) => boolean,
  policy: ToolPolicy,
): Promise<MitmProxy> {
  const INTERCEPT_DOMAINS = policy.interceptDomains;
  const sslCaDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "code-share-mitm-"),
  );

  return new Promise<MitmProxy>((resolve, reject) => {
    let proxyPort = 0;
    let proxyReady = false;
    const pendingSockets: net.Socket[] = [];

    // Reuse upstream TLS connections to Anthropic — saves a full handshake per
    // request and keeps a warm path for streaming.
    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: TCP_KEEPALIVE_MS,
      maxSockets: 64,
      timeout: SOCKET_IDLE_MS,
    });
    const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: TCP_KEEPALIVE_MS });

    const proxy = new Proxy();

    // Tune every internal server the library creates (one HTTPS server per
    // intercepted hostname) so Node's defaults (5 s keep-alive, 5 min request
    // timeout) don't turn a flaky tunnel into a multi-minute hang.
    const _origCreateHttps = (proxy as any)._createHttpsServer.bind(proxy);
    (proxy as any)._createHttpsServer = (
      options: any,
      cb: (port: number, server: https.Server, wss: unknown) => void,
    ) =>
      _origCreateHttps(options, (port: number, server: https.Server, wss: unknown) => {
        tuneServer(server);
        cb(port, server, wss);
      });

    // The library calls console.error() before invoking onError handlers, so we
    // patch _onError directly to suppress benign keep-alive teardowns at the source.
    const _origOnError = (proxy as any)._onError.bind(proxy);
    (proxy as any)._onError = (kind: string, ctx: any, err: Error) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (
        code === "ECONNRESET" ||
        code === "HPE_INVALID_EOF_STATE" ||
        code === "EPIPE" ||
        code === "ERR_STREAM_DESTROYED" ||
        code === "ERR_STREAM_WRITE_AFTER_END"
      )
        return;
      _origOnError(kind, ctx, err);
    };

    proxy.onError((ctx: any, err: any) => {
      if (!err) return;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ERR_HTTP_REQUEST_TIMEOUT") {
        // A receiver's request never finished arriving (dead tunnel/NAT path).
        // Claude Code on the receiver retries automatically; nothing to do here.
        logger.warn("[mitm] dropped a stalled client request (request timeout)");
        return;
      }
      logger.error("[mitm] proxy error", err);
      // Make sure the client gets *something* instead of hanging until its own timeout.
      try {
        const res = ctx?.proxyToClientResponse;
        if (res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json", "Retry-After": "2" });
          res.end(JSON.stringify(policy.upstreamErrorBody(String(err.message ?? err))));
        } else if (res && !res.writableEnded) {
          res.end();
        }
      } catch {}
    });

    function deny(ctx: any, method: string, hostname: string, reqPath: string) {
      logRequest(method, hostname, reqPath, "blocked");
      logger.info(`[req] ${method} ${hostname}${reqPath.split("?")[0].slice(0, 100)} → 403 blocked`);
      ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
      ctx.proxyToClientResponse.end("Not allowed by code-share policy");
    }

    // Replace whatever (placeholder) credentials the receiver sent with the
    // sharer's token. Never let the receiver's own headers leak upstream.
    function injectAuth(headers: Record<string, unknown>) {
      for (const h of policy.stripRequestHeaders) delete headers[h];
      delete headers["authorization"];
      for (const [k, v] of Object.entries(getAuthHeaders())) headers[k] = v;
    }

    proxy.onRequest((ctx: any, callback: () => void) => {
      const host = ctx.clientToProxyRequest.headers.host ?? "";
      const hostname = host.split(":")[0];
      const method = ctx.clientToProxyRequest.method ?? "GET";
      const reqPath = ctx.clientToProxyRequest.url ?? "/";

      if (PASSTHROUGH_DOMAINS.has(hostname)) {
        return callback();
      }

      if (!INTERCEPT_DOMAINS.has(hostname) || !policy.isAllowed(hostname, method, reqPath))
        return deny(ctx, method, hostname, reqPath);

      ctx[CTX_LOG_ID] = logRequest(method, hostname, reqPath, "allowed");

      const headers = (ctx.proxyToServerRequestOptions.headers =
        ctx.proxyToServerRequestOptions.headers ?? {});
      injectAuth(headers);

      ctx.proxyToServerRequestOptions.agent = ctx.isSSL ? httpsAgent : httpAgent;

      callback();
    });

    proxy.onResponse((ctx: any, callback: () => void) => {
      const logId = ctx[CTX_LOG_ID];
      const status = ctx.serverToProxyResponse.statusCode ?? 0;
      if (logId !== undefined) {
        setResponseStatus(logId, status);
      }

      const host = (ctx.clientToProxyRequest?.headers?.host ?? "").split(":")[0];
      {
        const req = ctx.clientToProxyRequest;
        const ua = String(req?.headers?.["user-agent"] ?? "").slice(0, 60);
        const pathOnly = String(req?.url ?? "/").split("?")[0].slice(0, 100);
        logger.info(`[req] ${req?.method ?? "?"} ${host}${pathOnly} → ${status} (${ua})`);
      }

      // Upstream rejected the injected token. Start a refresh immediately and,
      // if a refresh is possible, tell the receiver to retry (503 + Retry-After)
      // instead of showing it a login prompt. Both CLIs retry 5xx on their own.
      if (status === 401 && policy.authHosts.has(host)) {
        const retryable = canRefresh();
        onUpstreamUnauthorized();
        const body = Buffer.from(JSON.stringify(policy.unauthorizedBody(retryable)));
        if (retryable) {
          ctx.serverToProxyResponse.statusCode = 503;
          ctx.serverToProxyResponse.statusMessage = "Service Unavailable";
        }
        const respHeaders = ctx.serverToProxyResponse.headers;
        if (respHeaders) {
          respHeaders["content-type"] = "application/json";
          respHeaders["content-length"] = String(body.length);
          if (retryable) respHeaders["retry-after"] = "3";
          delete respHeaders["content-encoding"];
          delete respHeaders["transfer-encoding"];
        }
        ctx.addResponseFilter(
          new Transform({
            transform(_chunk, _enc, done) {
              done(); // discard original 401 body
            },
            flush(done) {
              this.push(body);
              done();
            },
          }),
        );
      }

      // Strip any response headers that could leak the sharer's credentials
      const respHeaders = ctx.serverToProxyResponse.headers;
      if (respHeaders) {
        for (const h of policy.stripResponseHeaders) delete respHeaders[h];
      }

      callback();
    });

    // Websocket upgrades inside an intercepted host (Codex streams Responses
    // over wss://chatgpt.com/backend-api/codex/responses). Same allow-list,
    // same header injection; the library pipes frames untouched afterwards.
    proxy.onWebSocketConnection((ctx: any, callback: (err?: Error) => void) => {
      const opts = ctx.proxyToServerWebSocketOptions;
      let target: URL;
      try {
        target = new URL(opts.url);
      } catch {
        ctx.clientToProxyWebSocket.close(1008, "Bad websocket target");
        return;
      }
      const hostname = target.hostname;
      const reqPath = target.pathname + target.search;
      if (!INTERCEPT_DOMAINS.has(hostname) || !policy.isAllowed(hostname, "GET", reqPath)) {
        logRequest("WS", hostname, reqPath, "blocked");
        logger.info(`[req] WS ${hostname}${reqPath.split("?")[0].slice(0, 100)} → blocked`);
        ctx.clientToProxyWebSocket.close(1008, "Not allowed by code-share policy");
        return;
      }
      const logId = logRequest("WS", hostname, reqPath, "allowed");
      opts.headers = opts.headers ?? {};
      injectAuth(opts.headers);
      opts.agent = httpsAgent;
      callback();

      const upstream = ctx.proxyToServerWebSocket;
      if (!upstream) return;
      upstream.on("open", () => {
        setResponseStatus(logId, 101);
        logger.info(`[req] WS ${hostname}${reqPath.split("?")[0].slice(0, 100)} → 101`);
      });
      // A non-101 answer (e.g. 401) — surface it like an HTTP 401 would be.
      upstream.on("unexpected-response", (req: http.ClientRequest, res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        setResponseStatus(logId, status);
        logger.info(`[req] WS ${hostname}${reqPath.split("?")[0].slice(0, 100)} → ${status}`);
        if (status === 401 && policy.authHosts.has(hostname)) onUpstreamUnauthorized();
        res.resume();
        req.destroy(new Error(`Unexpected server response: ${status}`));
        try {
          ctx.clientToProxyWebSocket.close(1011, `[code-share] upstream ${status}`);
        } catch {}
      });
    });

    proxy.onConnect(
      (req: any, rawSocket: any, head: any, callback: () => void) => {
        const socket = rawSocket as net.Socket;
        const connectAuth = req.headers["proxy-authorization"] ?? "";
        if (!checkAuth(connectAuth)) {
          socket.write(
            "HTTP/1.1 407 Proxy Authentication Required\r\n" +
              'Proxy-Authenticate: Basic realm="code-share"\r\n' +
              "Content-Length: 0\r\n" +
              "\r\n",
          );
          socket.destroy();
          return;
        }

        tuneSocket(socket);
        const [hostname, portStr] = ((req.url as string) ?? "").split(":");
        if (INTERCEPT_DOMAINS.has(hostname)) {
          callback();
          return;
        }
        // Non-Anthropic domain: transparent TCP tunnel — no cert, no decryption.
        // The client's TLS handshake goes straight to the real server.
        const port = parseInt(portStr, 10) || 443;
        const upstream = net.connect(port, hostname, () => {
          tuneSocket(upstream);
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head?.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.setTimeout(SOCKET_IDLE_MS, () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
      },
    );

    // Listen on a random localhost port — CA generation completes before callback fires
    proxy.listen(
      { port: 0, host: "127.0.0.1", sslCaDir, keepAlive: true },
      (err?: Error | null) => {
        if (err) return reject(err);

        (async () => {
          const httpServer: http.Server = (proxy as any).httpServer;
          tuneServer(httpServer);
          proxyPort = (httpServer.address() as net.AddressInfo).port;
          proxyReady = true;
          const caCertPem = fs.readFileSync(
            path.join(sslCaDir, "certs", "ca.pem"),
            "utf8",
          );
          const caKeyPem = fs.readFileSync(
            path.join(sslCaDir, "keys", "ca.private.key"),
            "utf8",
          );
          const serverCert = await generateServerCert(caCertPem, caKeyPem, certHosts);

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
              httpsAgent.destroy();
              httpAgent.destroy();
              fs.rm(sslCaDir, { recursive: true, force: true }, () => {});
            },
          });
        })().catch(reject);
      },
    );

    function pipeToProxy(socket: net.Socket) {
      tuneSocket(socket);
      const upstream = net.connect(proxyPort, "127.0.0.1");
      tuneSocket(upstream);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    }
  });
}
