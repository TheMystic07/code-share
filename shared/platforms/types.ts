export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier?: string;
}

export interface CredentialPayload {
  claudeAiOauth: OAuthCredentials;
}

export interface PlatformOps {
  /** Read the OAuth credentials from the platform credential store */
  readOAuthCredentials(): Promise<OAuthCredentials>;
  /** Check whether OAuth credentials exist in the platform credential store */
  credentialsExist(): Promise<boolean>;
  /** Write OAuth credentials to the platform credential store */
  writeOAuthCredentials(payload: CredentialPayload): Promise<void>;
  /** Return the human-friendly name of this machine */
  getSystemName(): Promise<string>;
}
