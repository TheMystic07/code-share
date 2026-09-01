import { platform } from "@shared/platforms";
import type { CredentialPayload, OAuthCredentials } from "@shared/platforms";
import { RefreshError, refreshAccessToken } from "@shared/oauth";
import { logger } from "../logger";

// In-memory only — token never written anywhere except back into the same
// credential store Claude Code itself uses (so the sharer's own `claude` keeps
// working after we rotate the refresh token).

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 15 * 60 * 1000;
/** Never schedule a refresh sooner than this (avoids tight loops on clock skew). */
const MIN_SCHEDULE_MS = 30 * 1000;
/** Don't hammer the token endpoint when many 401s arrive at once. */
const MIN_401_REFRESH_GAP_MS = 20 * 1000;

export type TokenState = "ok" | "refreshing" | "error" | "dead" | "uninitialized";

export interface TokenStatus {
  state: TokenState;
  /** Epoch ms when the current access token expires */
  expiresAt: number | null;
  lastRefreshAt: number | null;
  lastError: string | null;
  /** Number of consecutive failed refresh attempts */
  failures: number;
}

let cached: OAuthCredentials | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let inflight: Promise<OAuthCredentials> | null = null;
let last401RefreshAt = 0;
let stopped = false;

const status: TokenStatus = {
  state: "uninitialized",
  expiresAt: null,
  lastRefreshAt: null,
  lastError: null,
  failures: 0,
};

const listeners = new Set<(s: TokenStatus) => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn({ ...status });
    } catch {}
  }
}

function setStatus(patch: Partial<TokenStatus>): void {
  Object.assign(status, patch);
  notify();
}

export function getTokenStatus(): TokenStatus {
  return { ...status };
}

export function subscribeTokenStatus(fn: (s: TokenStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function isExpiringSoon(creds: OAuthCredentials, marginMs = REFRESH_MARGIN_MS): boolean {
  return creds.expiresAt - Date.now() <= marginMs;
}

function adopt(creds: OAuthCredentials): void {
  cached = creds;
  setStatus({ expiresAt: creds.expiresAt });
  scheduleRefresh();
}

function clearTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(delayOverrideMs?: number): void {
  clearTimer();
  if (stopped || !cached) return;
  const delay =
    delayOverrideMs ??
    Math.max(cached.expiresAt - Date.now() - REFRESH_MARGIN_MS, MIN_SCHEDULE_MS);
  refreshTimer = setTimeout(() => {
    void refreshNow("scheduled").catch(() => {});
  }, delay);
  refreshTimer.unref();
}

/** Backoff for retries after a failed refresh: 30s, 1m, 2m, 5m, 10m (cap). */
function retryDelay(failures: number): number {
  const steps = [30_000, 60_000, 120_000, 300_000, 600_000];
  return steps[Math.min(failures, steps.length) - 1] ?? 600_000;
}

async function readStore(): Promise<CredentialPayload | null> {
  try {
    return await platform().readCredentialPayload();
  } catch (err) {
    logger.warn("[token] could not read credential store", err);
    return null;
  }
}

async function writeStore(payload: CredentialPayload, creds: OAuthCredentials): Promise<void> {
  const merged: CredentialPayload = {
    ...payload,
    claudeAiOauth: { ...payload.claudeAiOauth, ...creds },
  };
  await platform().writeOAuthCredentials(merged);
}

/**
 * Refreshes the access token (single-flight). Order of operations:
 *  1. Re-read the credential store — if Claude Code on this machine already
 *     refreshed, adopt its token and skip the network call.
 *  2. Otherwise call the OAuth token endpoint with the stored refresh token.
 *  3. Persist the rotated tokens back to the store.
 */
export function refreshNow(reason: string): Promise<OAuthCredentials> {
  if (inflight) return inflight;
  inflight = (async () => {
    logger.info(`[token] refresh requested (${reason})`);
    setStatus({ state: "refreshing" });

    const payload = await readStore();
    const stored = payload?.claudeAiOauth ?? null;

    // Someone else (Claude Code) already refreshed — just use it.
    if (stored && cached && stored.accessToken !== cached.accessToken && !isExpiringSoon(stored)) {
      logger.info("[token] credential store already has a newer token — adopting it");
      adopt(stored);
      setStatus({ state: "ok", lastError: null, failures: 0, lastRefreshAt: Date.now() });
      return stored;
    }

    const source = stored ?? cached;
    if (!source) {
      setStatus({ state: "dead", lastError: "No credentials found" });
      throw new RefreshError("No credentials found", { fatal: true });
    }

    try {
      const fresh = await refreshAccessToken(source);
      if (payload) {
        try {
          await writeStore(payload, fresh);
        } catch (err) {
          // Not fatal for sharing, but the sharer's own `claude` may need a re-login later.
          logger.error("[token] failed to persist refreshed credentials", err);
        }
      }
      adopt(fresh);
      setStatus({ state: "ok", lastError: null, failures: 0, lastRefreshAt: Date.now() });
      logger.info(
        `[token] refreshed — expires in ${Math.round((fresh.expiresAt - Date.now()) / 60000)} min`,
      );
      return fresh;
    } catch (err) {
      const e = err as RefreshError;
      const failures = status.failures + 1;
      logger.error(`[token] refresh failed (${failures}x): ${e.message}`);

      // Race: Claude Code may have rotated the refresh token between our read and
      // our request. Re-read once more before declaring the token dead.
      if (e.fatal) {
        const again = await readStore();
        const s2 = again?.claudeAiOauth;
        if (s2 && s2.refreshToken !== source.refreshToken) {
          logger.info("[token] refresh token rotated by Claude Code — retrying with new one");
          setStatus({ failures });
          inflight = null;
          return refreshNow("rotated");
        }
      }

      // Keep serving the old access token while it is still valid.
      if (cached && cached.expiresAt > Date.now()) {
        setStatus({ state: "error", lastError: e.message, failures });
      } else {
        setStatus({ state: e.fatal ? "dead" : "error", lastError: e.message, failures });
      }
      // Fatal: poll the store (user might run `claude login` on this machine).
      scheduleRefresh(e.fatal ? 60_000 : retryDelay(failures));
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Loads credentials and refreshes immediately if they are (nearly) expired. */
export async function initToken(): Promise<OAuthCredentials> {
  stopped = false;
  const payload = await platform().readCredentialPayload();
  adopt(payload.claudeAiOauth);
  setStatus({ state: "ok" });
  if (isExpiringSoon(payload.claudeAiOauth)) {
    return refreshNow("startup");
  }
  return payload.claudeAiOauth;
}

export function getAccessToken(): string {
  if (!cached) throw new Error("Token not initialized — call initToken() first");
  return cached.accessToken;
}

export function hasToken(): boolean {
  return cached !== null;
}

/** True when a refresh could plausibly fix a 401 (refresh token present, not known-dead). */
export function canRefresh(): boolean {
  return !!cached?.refreshToken && status.state !== "dead";
}

export function getSubscriptionType(): string {
  return cached?.subscriptionType ?? "unknown";
}

export function getRateLimitTier(): string | undefined {
  return cached?.rateLimitTier;
}

/**
 * Called by the MITM when Anthropic answers 401 with the injected token.
 * Kicks off a refresh (rate-limited) so the receiver's retry succeeds.
 */
export function onUpstreamUnauthorized(): void {
  const now = Date.now();
  if (inflight) return;
  if (now - last401RefreshAt < MIN_401_REFRESH_GAP_MS) return;
  last401RefreshAt = now;
  void refreshNow("upstream 401").catch(() => {});
}

export function stopTokenRefresh(): void {
  stopped = true;
  clearTimer();
  cached = null;
  setStatus({ state: "uninitialized", expiresAt: null });
}
