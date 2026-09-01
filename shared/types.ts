export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
}

/** Non-secret plan metadata so the receiver's Claude Code offers the same models. */
export interface SharerSubscription {
  subscriptionType: string;
  rateLimitTier?: string;
}

// Wire format exchanged during pairing — produced by code-share, consumed by code-connect
export interface ConnectionFile {
  publicServerUrl: string | null;
  lanServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601
  caPem: string;
  sharerAccount: SharerAccount | null;
  sharerSubscription?: SharerSubscription | null;
  systemName: string;
  proxyUser: string;
  proxyPass: string;
}
