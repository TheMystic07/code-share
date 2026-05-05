import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
}

interface CredentialPayload {
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
  const payload: CredentialPayload = JSON.parse(stdout.trim());
  return payload.claudeAiOauth;
}

async function readFromFile(): Promise<OAuthCredentials> {
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  const raw = await fs.promises.readFile(credPath, "utf8");
  const payload: CredentialPayload = JSON.parse(raw);
  return payload.claudeAiOauth;
}

async function readToken(): Promise<OAuthCredentials> {
  if (process.platform === "darwin") return readFromKeychain();
  return readFromFile();
}

// Claude Code manages the OAuth refresh cycle on the sharer's machine and writes
// the updated token back to its credential store. We re-read before expiry so
// we're never caught with a stale token.
function scheduleTokenReread(creds: OAuthCredentials): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const msUntilReread = Math.max(
    creds.expiresAt - Date.now() - 5 * 60 * 1000,
    60_000,
  );
  refreshTimer = setTimeout(async () => {
    try {
      cached = await readToken();
      scheduleTokenReread(cached);
    } catch (err) {
      console.error("[token] credential re-read failed, will retry in 60s:", err);
      logger.error("[token] credential re-read failed", err);
      refreshTimer = setTimeout(() => scheduleTokenReread(creds), 60_000);
      refreshTimer.unref();
    }
  }, msUntilReread);
  refreshTimer.unref();
}

export async function initToken(): Promise<void> {
  cached = await readToken();
  scheduleTokenReread(cached);
}

export function getAccessToken(): string {
  if (!cached)
    throw new Error("Token not initialized — call initToken() first");
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
