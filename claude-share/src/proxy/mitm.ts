import { Proxy } from "http-mitm-proxy";
import type { EphemeralCA } from "../ca/generator.js";
import { getAccessToken } from "./token.js";
import { recordRequest, getSession } from "../session/manager.js";

// Domains the proxy intercepts and forwards to Anthropic with injected token
const INTERCEPT_DOMAINS = new Set([
  "api.anthropic.com",
  "platform.anthropic.com",
  "mcp-proxy.anthropic.com",
]);

// Domains blocked entirely
const BLOCKED_DOMAINS = new Set([
  "downloads.claude.ai",
]);

// API paths allowed on api.anthropic.com
const ALLOWED_PATHS: Array<{ method: string | null; prefix: string }> = [
  { method: "POST", prefix: "/v1/messages" },
  { method: "GET", prefix: "/v1/models" },
];

// api.anthropic.com paths that are always blocked regardless of method
const BLOCKED_PATH_PREFIXES = [
  "/v1/files",
  "/v1/fine_tuning",
  "/v1/assistants",
];

// platform.anthropic.com: allow /api/auth/* only
function isPlatformAllowed(path: string): boolean {
  return path.startsWith("/api/auth/");
}

function isApiAllowed(method: string, path: string): boolean {
  for (const blocked of BLOCKED_PATH_PREFIXES) {
    if (path.startsWith(blocked)) return false;
  }
  for (const allowed of ALLOWED_PATHS) {
    if (path.startsWith(allowed.prefix)) {
      if (allowed.method === null || allowed.method === method.toUpperCase()) return true;
    }
  }
  return false;
}

export interface MitmProxy {
  /** Feed a socket that has already been identified as a CONNECT request */
  handleSocket(socket: import("node:net").Socket): void;
  close(): void;
}

export function createMitmProxy(ca: EphemeralCA, connectionId?: string): MitmProxy {
  const proxy = new Proxy();

  proxy.use(Proxy.gunzip);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proxy.onError((ctx: any, err: any) => {
    if (err && (err as NodeJS.ErrnoException).code !== "ECONNRESET") {
      console.error("[mitm] error:", err.message);
    }
  });

  proxy.onRequest((ctx: any, callback: () => void) => {
    const host = ctx.clientToProxyRequest.headers.host ?? "";
    const hostname = host.split(":")[0];
    const method = ctx.clientToProxyRequest.method ?? "GET";
    const path = ctx.clientToProxyRequest.url ?? "/";

    // Block entirely
    if (BLOCKED_DOMAINS.has(hostname)) {
      ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
      ctx.proxyToClientResponse.end("Blocked by claude-share");
      return;
    }

    if (!INTERCEPT_DOMAINS.has(hostname)) {
      // Pass through unknown domains without modification
      return callback();
    }

    // Enforce allowlist per domain
    if (hostname === "api.anthropic.com" && !isApiAllowed(method, path)) {
      ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
      ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
      return;
    }
    if (hostname === "platform.anthropic.com" && !isPlatformAllowed(path)) {
      ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/plain" });
      ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
      return;
    }

    // Inject real Bearer token; strip any dummy token the receiver sent
    ctx.proxyToServerRequestOptions.headers = ctx.proxyToServerRequestOptions.headers ?? {};
    ctx.proxyToServerRequestOptions.headers["authorization"] = `Bearer ${getAccessToken()}`;

    // Strip headers that could leak receiver identity
    delete ctx.proxyToServerRequestOptions.headers["x-forwarded-for"];
    delete ctx.proxyToServerRequestOptions.headers["x-real-ip"];

    // Record usage
    if (connectionId) {
      const session = getSession();
      if (session) recordRequest(session, connectionId);
    }

    callback();
  });

  // Configure proxy to use our ephemeral CA for TLS interception
  proxy.onConnect((_req: any, _socket: any, _head: any, callback: () => void) => {
    callback();
  });

  proxy.listen({ port: 0, sslCaDir: undefined }, () => {});

  // Override SSL options to use our CA
  (proxy as any).sslCertCache = {};
  (proxy as any).sslOptions = {
    key: ca.keyPem,
    cert: ca.certPem,
  };

  return {
    handleSocket(socket) {
      (proxy as any).onConnection(socket);
    },
    close() {
      proxy.close();
    },
  };
}
