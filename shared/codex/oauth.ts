import { RefreshError } from "../oauth";
import type { CodexTokens } from "./store";

// Public OAuth client id of the Codex CLI (same one `codex login` uses).
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  error?: string | { code?: string; message?: string };
  error_description?: string;
}

/** Error codes codex treats as "login required" — retrying cannot help. */
const PERMANENT_CODES = /refresh_token_expired|refresh_token_reused|refresh_token_invalidated|invalid_grant/i;

/**
 * Exchanges the refresh token for fresh tokens exactly like codex does. Returns
 * the new token set (the caller persists it, together with `last_refresh`).
 * Never logs the tokens.
 */
export async function refreshCodexTokens(
  tokens: CodexTokens,
  opts: { timeoutMs?: number } = {},
): Promise<CodexTokens> {
  if (!tokens.refresh_token) {
    throw new RefreshError("No refresh token available", { fatal: true });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new RefreshError(`Network error during token refresh: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let data: RefreshResponse | null = null;
  try {
    data = (await res.json()) as RefreshResponse;
  } catch {
    data = null;
  }

  if (res.status !== 200 || !data?.access_token) {
    const code =
      typeof data?.error === "string" ? data.error : (data?.error?.code ?? "");
    const text = `${code} ${data?.error_description ?? ""}`;
    const fatal = res.status === 401 || (res.status === 400 && PERMANENT_CODES.test(text)) || PERMANENT_CODES.test(code);
    throw new RefreshError(
      `Token refresh failed (HTTP ${res.status}${code ? `, ${code}` : ""})`,
      { fatal, status: res.status },
    );
  }

  return {
    ...tokens,
    id_token: data.id_token || tokens.id_token,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
  };
}
