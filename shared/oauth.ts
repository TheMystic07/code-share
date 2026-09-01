import type { OAuthCredentials } from "./platforms/types";

// Public OAuth client id of the Claude Code CLI (same one `claude login` uses).
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export const DEFAULT_SCOPES = [
  "user:file_upload",
  "user:inference",
  "user:mcp_servers",
  "user:profile",
  "user:sessions:claude_code",
];

export class RefreshError extends Error {
  /** True when the refresh token itself is rejected — retrying won't help. */
  fatal: boolean;
  status: number | null;
  constructor(message: string, opts: { fatal?: boolean; status?: number | null } = {}) {
    super(message);
    this.name = "RefreshError";
    this.fatal = opts.fatal ?? false;
    this.status = opts.status ?? null;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Exchanges the refresh token for a fresh access token, exactly like Claude
 * Code does internally. Returns a new credentials object (the caller persists
 * it). Never logs the tokens.
 */
export async function refreshAccessToken(
  creds: OAuthCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<OAuthCredentials> {
  if (!creds.refreshToken) {
    throw new RefreshError("No refresh token available", { fatal: true });
  }

  const scopes = creds.scopes?.length ? creds.scopes : DEFAULT_SCOPES;
  const body = {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: CLAUDE_CODE_CLIENT_ID,
    scope: scopes.join(" "),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new RefreshError(`Network error during token refresh: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let data: TokenResponse | null = null;
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    data = null;
  }

  if (res.status !== 200 || !data?.access_token || typeof data.expires_in !== "number") {
    const code = data?.error ?? "";
    const fatal =
      res.status === 400 || res.status === 401 || res.status === 403
        ? /invalid_grant|invalid_refresh|expired|revoked|invalid_client/i.test(
            `${code} ${data?.error_description ?? ""}`,
          ) || res.status === 401
        : false;
    throw new RefreshError(
      `Token refresh failed (HTTP ${res.status}${code ? `, ${code}` : ""})`,
      { fatal, status: res.status },
    );
  }

  const now = Date.now();
  const refreshed: OAuthCredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAt: now + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(" ").filter(Boolean) : scopes,
  };
  if (typeof data.refresh_token_expires_in === "number") {
    refreshed.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000;
  }
  return refreshed;
}
