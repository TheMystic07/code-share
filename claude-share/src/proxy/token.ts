import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
}

interface KeychainPayload {
  claudeAiOauth: OAuthCredentials;
}

// In-memory only — token never written to disk
let cached: OAuthCredentials | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

async function readFromKeychain(): Promise<OAuthCredentials> {
  const username = os.userInfo().username;
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
    "-a",
    username,
    "-w",
  ]);
  const payload: KeychainPayload = JSON.parse(stdout.trim());
  return payload.claudeAiOauth;
}

// Exact endpoint/payload to be confirmed by observing Claude Code's own refresh flow.
// See open question #1 in the build plan.
async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials> {
  const resp = await fetch("https://claude.ai/api/auth/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope.split(" "),
    subscriptionType: cached?.subscriptionType ?? "pro",
  };
}

function scheduleRefresh(creds: OAuthCredentials): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // Refresh 55 minutes before expiry (token lifetime is typically 1 hour)
  const msUntilRefresh = Math.max(creds.expiresAt - Date.now() - 55 * 60 * 1000, 0);
  refreshTimer = setTimeout(async () => {
    try {
      cached = await refreshAccessToken(creds.refreshToken);
      scheduleRefresh(cached);
    } catch (err) {
      console.error("[token] Refresh failed, will retry in 60s:", err);
      setTimeout(() => cached && scheduleRefresh(cached), 60_000);
    }
  }, msUntilRefresh);
  refreshTimer.unref();
}

export async function initToken(): Promise<void> {
  cached = await readFromKeychain();
  scheduleRefresh(cached);
}

export function getAccessToken(): string {
  if (!cached) throw new Error("Token not initialized — call initToken() first");
  return cached.accessToken;
}

export function getSubscriptionType(): string {
  return cached?.subscriptionType ?? "unknown";
}

export function stopTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  cached = null;
}
