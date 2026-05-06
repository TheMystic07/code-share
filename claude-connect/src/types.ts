export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
}

export interface ConnectionFile {
  publicServerUrl: string | null;
  lanServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601
  caPem: string;
  sharerAccount: SharerAccount | null;
  systemName?: string;
  proxyUser: string;
  proxyPass: string;
}

export interface SavedConnection {
  id: string;
  systemName: string;
  lanServerUrl: string | null;
  publicServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601 — used to prune expired connections on startup
  caPem: string;
  savedAt: string;
  sharerAccount: SharerAccount | null;
  proxyUser: string;
  proxyPass: string;
}

export interface ReceiverConfig {
  deviceName: string;
}
