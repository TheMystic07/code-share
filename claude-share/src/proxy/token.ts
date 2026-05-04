import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

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

// Claude Code manages the OAuth refresh cycle on the sharer's machine and writes
// the updated token back to Keychain. We just re-read from Keychain before expiry
// instead of attempting the refresh ourselves.
function scheduleKeychainReread(creds: OAuthCredentials): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // Re-read 5 minutes before the token expires so we're never caught with a stale token
  const msUntilReread = Math.max(creds.expiresAt - Date.now() - 5 * 60 * 1000, 60_000);
  refreshTimer = setTimeout(async () => {
    try {
      cached = await readFromKeychain();
      scheduleKeychainReread(cached);
    } catch (err) {
      console.error("[token] Keychain re-read failed, will retry in 60s:", err);
      refreshTimer = setTimeout(() => scheduleKeychainReread(creds), 60_000);
      refreshTimer.unref();
    }
  }, msUntilReread);
  refreshTimer.unref();
}

export async function initToken(): Promise<void> {
  cached = await readFromKeychain();
  scheduleKeychainReread(cached);
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
