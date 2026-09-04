import { RefreshError } from "@shared/oauth";
import { logger } from "../logger";

// Generic single-flight token refresher shared by the Claude and Codex token
// managers. Tokens live in memory only and are written back solely to the
// credential store the CLI itself uses. Log lines carry timings/state, never
// token material.

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

export interface TokenAdapter<C> {
  /** Log prefix, e.g. "token" */
  tag: string;
  /** Re-read the credential store. null = no credentials on this machine. */
  readStore(): Promise<C | null>;
  /** Persist rotated credentials back to the same store. */
  writeStore(creds: C): Promise<void>;
  /** Exchange the refresh token for a new credential set. */
  refresh(creds: C): Promise<C>;
  accessToken(creds: C): string;
  refreshToken(creds: C): string;
  /** Epoch ms */
  expiresAt(creds: C): number;
}

export interface TokenManager<C> {
  /** Loads credentials and refreshes immediately if they are (nearly) expired. */
  init(): Promise<C>;
  refreshNow(reason: string): Promise<C>;
  getCredentials(): C | null;
  getAccessToken(): string;
  /** True when a refresh could plausibly fix a 401 (refresh token present, not known-dead). */
  canRefresh(): boolean;
  /** Called by the MITM when upstream answers 401 with the injected token. */
  onUpstreamUnauthorized(): void;
  getStatus(): TokenStatus;
  subscribe(fn: (s: TokenStatus) => void): () => void;
  stop(): void;
}

/** Backoff for retries after a failed refresh: 30s, 1m, 2m, 5m, 10m (cap). */
function retryDelay(failures: number): number {
  const steps = [30_000, 60_000, 120_000, 300_000, 600_000];
  return steps[Math.min(failures, steps.length) - 1] ?? 600_000;
}

export function createTokenManager<C>(adapter: TokenAdapter<C>): TokenManager<C> {
  const tag = `[${adapter.tag}]`;
  let cached: C | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let inflight: Promise<C> | null = null;
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

  function isExpiringSoon(creds: C, marginMs = REFRESH_MARGIN_MS): boolean {
    return adapter.expiresAt(creds) - Date.now() <= marginMs;
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
      Math.max(adapter.expiresAt(cached) - Date.now() - REFRESH_MARGIN_MS, MIN_SCHEDULE_MS);
    refreshTimer = setTimeout(() => {
      void refreshNow("scheduled").catch(() => {});
    }, delay);
    refreshTimer.unref();
  }

  function adopt(creds: C): void {
    cached = creds;
    setStatus({ expiresAt: adapter.expiresAt(creds) });
    scheduleRefresh();
  }

  async function readStore(): Promise<C | null> {
    try {
      return await adapter.readStore();
    } catch (err) {
      logger.warn(`${tag} could not read credential store`, err);
      return null;
    }
  }

  /**
   * Refreshes the access token (single-flight). Order of operations:
   *  1. Re-read the credential store — if the CLI on this machine already
   *     refreshed, adopt its token and skip the network call.
   *  2. Otherwise call the token endpoint with the stored refresh token.
   *  3. Persist the rotated tokens back to the store.
   */
  function refreshNow(reason: string): Promise<C> {
    if (inflight) return inflight;
    inflight = (async () => {
      logger.info(`${tag} refresh requested (${reason})`);
      setStatus({ state: "refreshing" });

      const stored = await readStore();

      // Someone else (the CLI) already refreshed — just use it.
      if (
        stored &&
        cached &&
        adapter.accessToken(stored) !== adapter.accessToken(cached) &&
        !isExpiringSoon(stored)
      ) {
        logger.info(`${tag} credential store already has a newer token — adopting it`);
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
        const fresh = await adapter.refresh(source);
        try {
          await adapter.writeStore(fresh);
        } catch (err) {
          // Not fatal for sharing, but the sharer's own CLI may need a re-login later.
          logger.error(`${tag} failed to persist refreshed credentials`, err);
        }
        adopt(fresh);
        setStatus({ state: "ok", lastError: null, failures: 0, lastRefreshAt: Date.now() });
        logger.info(
          `${tag} refreshed — expires in ${Math.round((adapter.expiresAt(fresh) - Date.now()) / 60000)} min`,
        );
        return fresh;
      } catch (err) {
        const e = err as RefreshError;
        const failures = status.failures + 1;
        logger.error(`${tag} refresh failed (${failures}x): ${e.message}`);

        // Race: the CLI may have rotated the refresh token between our read and
        // our request. Re-read once more before declaring the token dead.
        if (e.fatal) {
          const again = await readStore();
          if (again && adapter.refreshToken(again) !== adapter.refreshToken(source)) {
            logger.info(`${tag} refresh token rotated by the CLI — retrying with new one`);
            setStatus({ failures });
            inflight = null;
            return refreshNow("rotated");
          }
        }

        // Keep serving the old access token while it is still valid.
        if (cached && adapter.expiresAt(cached) > Date.now()) {
          setStatus({ state: "error", lastError: e.message, failures });
        } else {
          setStatus({ state: e.fatal ? "dead" : "error", lastError: e.message, failures });
        }
        // Fatal: poll the store (user might log in again on this machine).
        scheduleRefresh(e.fatal ? 60_000 : retryDelay(failures));
        throw e;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    async init() {
      stopped = false;
      const creds = await adapter.readStore();
      if (!creds) throw new Error("No credentials found");
      adopt(creds);
      setStatus({ state: "ok" });
      if (isExpiringSoon(creds)) return refreshNow("startup");
      return creds;
    },
    refreshNow,
    getCredentials: () => cached,
    getAccessToken() {
      if (!cached) throw new Error("Token not initialized — call init() first");
      return adapter.accessToken(cached);
    },
    canRefresh() {
      return !!cached && !!adapter.refreshToken(cached) && status.state !== "dead";
    },
    onUpstreamUnauthorized() {
      const now = Date.now();
      if (inflight) return;
      if (now - last401RefreshAt < MIN_401_REFRESH_GAP_MS) return;
      last401RefreshAt = now;
      void refreshNow("upstream 401").catch(() => {});
    },
    getStatus: () => ({ ...status }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      clearTimer();
      cached = null;
      setStatus({ state: "uninitialized", expiresAt: null });
    },
  };
}
