export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier?: string;
  /** Epoch ms — present in newer Claude Code versions */
  refreshTokenExpiresAt?: number;
}

/**
 * The full credential blob Claude Code stores. Only `claudeAiOauth` is
 * understood here; every other key is preserved verbatim on write so we never
 * clobber data written by a newer Claude Code.
 */
export interface CredentialPayload {
  claudeAiOauth: OAuthCredentials;
  [key: string]: unknown;
}

export interface PlatformOps {
  /** Read the OAuth credentials from the platform credential store */
  readOAuthCredentials(): Promise<OAuthCredentials>;
  /** Read the entire credential payload (all keys) from the credential store */
  readCredentialPayload(): Promise<CredentialPayload>;
  /** Check whether OAuth credentials exist in the platform credential store */
  credentialsExist(): Promise<boolean>;
  /** Write the full credential payload to the platform credential store */
  writeOAuthCredentials(payload: CredentialPayload): Promise<void>;
  /** Return the human-friendly name of this machine */
  getSystemName(): Promise<string>;
}
