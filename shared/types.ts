import type { ShareTool } from "./tool";

export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
}

/**
 * Non-secret plan metadata so the receiver's CLI offers the same models.
 * Claude: `subscriptionType` (max/pro/…) + `rateLimitTier`.
 * Codex:  `subscriptionType` = ChatGPT plan type (plus/pro/team/…).
 */
export interface SharerSubscription {
  subscriptionType: string;
  rateLimitTier?: string;
}

// Wire format exchanged during pairing — produced by code-share, consumed by code-connect
export interface ConnectionFile {
  /** Which CLI this share is for. Missing = "claude" (blobs from older sharers). */
  tool?: ShareTool;
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
