import type { ShareTool } from "@shared/tool";
import type { SharerAccount, SharerSubscription } from "@shared/types";

export type { ConnectionFile, SharerAccount, SharerSubscription } from "@shared/types";

export interface SavedConnection {
  id: string;
  /** CLI this share is for. Missing = "claude" (connections saved by older versions). */
  tool?: ShareTool;
  systemName: string;
  lanServerUrl: string | null;
  publicServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601 — used to prune expired connections on startup
  caPem: string;
  savedAt: string;
  sharerAccount: SharerAccount | null;
  sharerSubscription?: SharerSubscription | null;
  proxyUser: string;
  proxyPass: string;
}

export interface ReceiverConfig {
  deviceName: string;
  hasConnectTermsAgreed?: boolean;
}
