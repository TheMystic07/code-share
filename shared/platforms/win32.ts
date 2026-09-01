import os from "node:os";

import {
  credentialsFileExists,
  readOAuthFromFile,
  readPayloadFromFile,
  writePayloadToFile,
} from "./fileStore";
import type { PlatformOps } from "./types";

// Claude Code on Windows stores credentials in %USERPROFILE%\.claude\.credentials.json
// (or $CLAUDE_CONFIG_DIR\.credentials.json) — same layout as Linux.
const win32: PlatformOps = {
  readOAuthCredentials: readOAuthFromFile,
  readCredentialPayload: readPayloadFromFile,
  async credentialsExist(): Promise<boolean> {
    return credentialsFileExists();
  },
  writeOAuthCredentials: writePayloadToFile,

  async getSystemName(): Promise<string> {
    return process.env.COMPUTERNAME?.trim() || os.hostname();
  },
};

export default win32;
