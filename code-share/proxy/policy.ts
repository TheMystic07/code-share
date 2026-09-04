import type { ShareTool } from "@shared/tool";

// What the MITM is allowed to forward, per shared tool. Both policies follow
// the same idea: intercept only the vendor's API hosts, allow exactly what the
// CLI needs to behave like a logged-in client, and block anything that could
// create long-lived artefacts or credentials on the sharer's account.

interface AllowRule {
  /** null = any method */
  method: string | null;
  prefix: string;
}

export interface ToolPolicy {
  tool: ShareTool;
  /** Hosts whose TLS is terminated and re-encrypted with the injected token. */
  interceptDomains: ReadonlySet<string>;
  /** Hosts where an upstream 401 means our injected token was rejected. */
  authHosts: ReadonlySet<string>;
  /** Request headers from the receiver that must never reach upstream. */
  stripRequestHeaders: readonly string[];
  /** Response headers that must never reach the receiver. */
  stripResponseHeaders: readonly string[];
  isAllowed(hostname: string, method: string, reqPath: string): boolean;
  /** Body sent to the receiver when the injected token was rejected upstream. */
  unauthorizedBody(retryable: boolean): unknown;
  /** Body sent when the upstream connection itself failed. */
  upstreamErrorBody(message: string): unknown;
}

function matches(rules: readonly AllowRule[], blocked: readonly string[], method: string, reqPath: string): boolean {
  const cleanPath = reqPath.split("?")[0] ?? reqPath;
  for (const b of blocked) {
    if (cleanPath.startsWith(b)) return false;
  }
  for (const r of rules) {
    if (cleanPath.startsWith(r.prefix) && (r.method === null || r.method === method.toUpperCase())) {
      return true;
    }
  }
  return false;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

// api.anthropic.com allowed paths.
// Everything Claude Code needs to behave exactly like a logged-in client:
//   - inference + token counting
//   - model discovery / entitlements (bootstrap, models)
//   - account + usage display (profile, usage, roles, validate)
//   - feature gates (GrowthBook remote eval — what enables new models/modes)
//   - org-managed settings and policy limits
const CLAUDE_API_ALLOWED: AllowRule[] = [
  { method: null, prefix: "/api/hello" },
  { method: "POST", prefix: "/v1/messages" }, // includes /v1/messages/count_tokens
  { method: "GET", prefix: "/v1/models" },
  { method: "GET", prefix: "/api/claude_cli/bootstrap" },
  { method: "GET", prefix: "/api/claude_cli_profile" },
  { method: "GET", prefix: "/api/oauth/profile" },
  { method: "GET", prefix: "/api/oauth/usage" },
  { method: "GET", prefix: "/api/oauth/validate" },
  { method: "GET", prefix: "/api/oauth/claude_cli/roles" },
  { method: "POST", prefix: "/api/eval/" },
  { method: "POST", prefix: "/api/eval-authed/" },
  { method: "GET", prefix: "/api/features/" },
  { method: "GET", prefix: "/api/claude_code/settings" },
  { method: "GET", prefix: "/api/claude_code/policy_limits" },
  { method: "GET", prefix: "/api/claude_code/organizations/metrics_enabled" },
  { method: "GET", prefix: "/api/claude_code/notification/preferences" },
];

// api.anthropic.com paths that are always blocked regardless of method.
// These could create long-lived artefacts or credentials on the sharer's account.
const CLAUDE_API_BLOCKED = [
  "/v1/files",
  "/v1/fine_tuning",
  "/v1/assistants",
  "/v1/messages/batches",
  "/api/oauth/claude_cli/create_api_key",
  "/api/oauth/file_upload",
  "/api/oauth/files",
  "/api/oauth/account",
  "/api/oauth/organizations",
];

const CLAUDE_POLICY: ToolPolicy = {
  tool: "claude",
  interceptDomains: new Set([
    "api.anthropic.com",
    "platform.anthropic.com",
    "platform.claude.com",
    "mcp-proxy.anthropic.com",
  ]),
  authHosts: new Set(["api.anthropic.com"]),
  stripRequestHeaders: ["x-api-key", "x-forwarded-for", "x-real-ip", "via"],
  stripResponseHeaders: ["authorization", "set-cookie", "x-api-key", "anthropic-organization-id"],
  isAllowed(hostname, method, reqPath) {
    switch (hostname) {
      case "api.anthropic.com":
        return matches(CLAUDE_API_ALLOWED, CLAUDE_API_BLOCKED, method, reqPath);
      case "platform.anthropic.com":
        return reqPath.startsWith("/api/auth/");
      case "platform.claude.com":
        return reqPath.startsWith("/v1/oauth/");
      case "mcp-proxy.anthropic.com":
        return true;
      default:
        return false;
    }
  },
  unauthorizedBody(retryable) {
    return retryable
      ? {
          type: "error",
          error: {
            type: "overloaded_error",
            message: "[code-share] The sharer's token expired — refreshing it now, please retry.",
          },
        }
      : {
          type: "error",
          error: {
            type: "authentication_error",
            message:
              "[code-share] The sharer's Anthropic token is invalid and could not be refreshed. The sharer must run 'claude login'.",
          },
        };
  },
  upstreamErrorBody(message) {
    return { type: "error", error: { type: "api_error", message: `[code-share] upstream error: ${message}` } };
  },
};

// ── Codex (ChatGPT login) ────────────────────────────────────────────────────

// chatgpt.com allowed paths. Codex in ChatGPT mode talks to
// https://chatgpt.com/backend-api/codex/* for inference and
// https://chatgpt.com/backend-api/wham/* for account/usage display.
//   - /codex/responses is used both over HTTP and as a websocket upgrade (GET)
const CODEX_API_ALLOWED: AllowRule[] = [
  { method: null, prefix: "/backend-api/codex/responses" }, // includes /responses/compact + websocket
  { method: "GET", prefix: "/backend-api/codex/models" },
  { method: "POST", prefix: "/backend-api/codex/alpha/search" }, // standalone web search
  { method: "GET", prefix: "/backend-api/wham/usage" },
  { method: "GET", prefix: "/backend-api/wham/rate-limit-reset-credits" },
  { method: "GET", prefix: "/backend-api/wham/accounts/check" },
  { method: "GET", prefix: "/backend-api/wham/profiles/me" },
  { method: "GET", prefix: "/backend-api/wham/config/bundle" },
  { method: "GET", prefix: "/backend-api/wham/settings/user" },
];

// Always blocked on chatgpt.com: anything that spends the sharer's credits,
// creates cloud tasks / artefacts, changes account settings or registers
// long-lived identities.
const CODEX_API_BLOCKED = [
  "/backend-api/wham/rate-limit-reset-credits/consume",
  "/backend-api/wham/tasks",
  "/backend-api/wham/workspace-messages",
  "/backend-api/codex/memories",
  "/backend-api/codex/images",
  "/backend-api/codex/realtime",
  "/backend-api/codex/files",
  "/ps/apps",
];

const CODEX_POLICY: ToolPolicy = {
  tool: "codex",
  interceptDomains: new Set(["chatgpt.com"]),
  authHosts: new Set(["chatgpt.com"]),
  stripRequestHeaders: [
    "x-api-key",
    "x-forwarded-for",
    "x-real-ip",
    "via",
    "cookie",
    "openai-organization",
    "openai-project",
  ],
  stripResponseHeaders: ["authorization", "set-cookie", "x-api-key"],
  isAllowed(hostname, method, reqPath) {
    if (hostname !== "chatgpt.com") return false;
    return matches(CODEX_API_ALLOWED, CODEX_API_BLOCKED, method, reqPath);
  },
  unauthorizedBody(retryable) {
    return retryable
      ? {
          error: {
            type: "server_error",
            code: "code_share_refreshing",
            message: "[code-share] The sharer's ChatGPT token expired — refreshing it now, please retry.",
          },
        }
      : {
          error: {
            type: "invalid_request_error",
            code: "invalid_token",
            message:
              "[code-share] The sharer's ChatGPT token is invalid and could not be refreshed. The sharer must run 'codex login'.",
          },
        };
  },
  upstreamErrorBody(message) {
    return { error: { type: "server_error", code: "upstream_error", message: `[code-share] upstream error: ${message}` } };
  },
};

export function policyFor(tool: ShareTool): ToolPolicy {
  return tool === "codex" ? CODEX_POLICY : CLAUDE_POLICY;
}
