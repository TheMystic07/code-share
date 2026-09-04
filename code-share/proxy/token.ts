import { platform } from "@shared/platforms";
import type { CredentialPayload, OAuthCredentials } from "@shared/platforms";
import { refreshAccessToken } from "@shared/oauth";
import {
  codexIdentity,
  jwtExpiryMs,
  readCodexAuth,
  writeCodexAuth,
  type CodexAuthRecord,
  type CodexTokens,
} from "@shared/codex/store";
import { refreshCodexTokens } from "@shared/codex/oauth";
import type { ShareTool } from "@shared/tool";
import type { SharerAccount, SharerSubscription } from "@shared/types";
import { createTokenManager, type TokenAdapter, type TokenManager } from "./tokenManager";

export type { TokenState, TokenStatus } from "./tokenManager";

// One token manager per tool; exactly one is active for a share session.
// Everything else in code-share talks to the active one through the facade
// below, so the MITM / TUI don't care which CLI is being shared.

// ── Claude Code ──────────────────────────────────────────────────────────────

// The full credential blob is kept so unknown keys survive a write-back.
let claudePayload: CredentialPayload | null = null;

const claudeAdapter: TokenAdapter<OAuthCredentials> = {
  tag: "token",
  async readStore() {
    if (!(await platform().credentialsExist())) return null;
    const payload = await platform().readCredentialPayload();
    claudePayload = payload;
    return payload.claudeAiOauth;
  },
  async writeStore(creds) {
    const base = claudePayload ?? { claudeAiOauth: creds };
    claudePayload = { ...base, claudeAiOauth: { ...base.claudeAiOauth, ...creds } };
    await platform().writeOAuthCredentials(claudePayload);
  },
  refresh: (creds) => refreshAccessToken(creds),
  accessToken: (c) => c.accessToken,
  refreshToken: (c) => c.refreshToken,
  expiresAt: (c) => c.expiresAt,
};

// ── Codex (ChatGPT login) ────────────────────────────────────────────────────

interface CodexCreds {
  tokens: CodexTokens;
  record: CodexAuthRecord;
}

/** ChatGPT access tokens are JWTs; when `exp` is missing fall back to codex's own 8-day rule. */
const CODEX_FALLBACK_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;

const codexAdapter: TokenAdapter<CodexCreds> = {
  tag: "codex-token",
  async readStore() {
    const record = await readCodexAuth();
    if (!record) return null;
    return { tokens: record.auth.tokens!, record };
  },
  async writeStore(creds) {
    await writeCodexAuth(creds.record);
  },
  async refresh(creds) {
    const tokens = await refreshCodexTokens(creds.tokens);
    return {
      tokens,
      record: {
        store: creds.record.store,
        auth: {
          ...creds.record.auth,
          auth_mode: creds.record.auth.auth_mode ?? "chatgpt",
          tokens,
          // codex refreshes proactively when this is >8 days old — keep it current.
          last_refresh: new Date().toISOString(),
        },
      },
    };
  },
  accessToken: (c) => c.tokens.access_token,
  refreshToken: (c) => c.tokens.refresh_token,
  expiresAt(c) {
    const exp = jwtExpiryMs(c.tokens.access_token);
    if (exp !== null) return exp;
    const last = c.record.auth.last_refresh ? Date.parse(c.record.auth.last_refresh) : NaN;
    return (Number.isFinite(last) ? last : Date.now()) + CODEX_FALLBACK_LIFETIME_MS;
  },
};

// ── Facade ───────────────────────────────────────────────────────────────────

let activeTool: ShareTool = "claude";
const claudeManager = createTokenManager(claudeAdapter);
const codexManager = createTokenManager(codexAdapter);

function active(): TokenManager<unknown> {
  return (activeTool === "codex" ? codexManager : claudeManager) as TokenManager<unknown>;
}

/** Must be called once before initToken(). */
export function setActiveTool(tool: ShareTool): void {
  activeTool = tool;
}

export function getActiveTool(): ShareTool {
  return activeTool;
}

export function initToken(): Promise<unknown> {
  return active().init();
}

export function getAccessToken(): string {
  return active().getAccessToken();
}

export function canRefresh(): boolean {
  return active().canRefresh();
}

export function onUpstreamUnauthorized(): void {
  active().onUpstreamUnauthorized();
}

export function getTokenStatus() {
  return active().getStatus();
}

export function subscribeTokenStatus(fn: Parameters<TokenManager<unknown>["subscribe"]>[0]) {
  return active().subscribe(fn);
}

export function stopTokenRefresh(): void {
  active().stop();
}

/** Headers the MITM injects on every intercepted request. */
export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${getAccessToken()}` };
  if (activeTool === "codex") {
    const creds = codexManager.getCredentials();
    const accountId = creds ? codexIdentity(creds.tokens).accountId : null;
    if (accountId) headers["chatgpt-account-id"] = accountId;
  }
  return headers;
}

/** Non-secret plan info so the receiver's CLI offers the same models/modes. */
export function getSharerSubscription(): SharerSubscription | null {
  if (activeTool === "codex") {
    const creds = codexManager.getCredentials();
    const plan = creds ? codexIdentity(creds.tokens).planType : null;
    return { subscriptionType: plan ?? "unknown" };
  }
  const creds = claudeManager.getCredentials();
  return {
    subscriptionType: creds?.subscriptionType ?? "unknown",
    rateLimitTier: creds?.rateLimitTier,
  };
}

/** Account shown on the receiver — codex only knows the email from the id_token. */
export function getCodexSharerAccount(): SharerAccount | null {
  const creds = codexManager.getCredentials();
  if (!creds) return null;
  const id = codexIdentity(creds.tokens);
  if (!id.email) return null;
  return { emailAddress: id.email, displayName: "", organizationName: id.planType ?? "" };
}
