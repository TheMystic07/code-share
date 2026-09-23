import type { ShareTool } from "./tool";

export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
  /**
   * Codex only: the sharer's ChatGPT account/workspace id. The receiver's
   * placeholder auth.json carries it so its identity mirrors the sharer's; the
   * proxy also rewrites Codex's workspace-routing response so a receiver signed
   * into a *different* account still works.
   */
  accountId?: string;
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
