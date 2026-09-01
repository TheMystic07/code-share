import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import {
  credentialsFileExists,
  readPayloadFromFile,
} from "./fileStore";
import type { CredentialPayload, OAuthCredentials, PlatformOps } from "./types";

const execFileAsync = promisify(execFile);
const SERVICE = "Claude Code-credentials";

function username() {
  return os.userInfo().username;
}

async function readKeychainPayload(): Promise<CredentialPayload> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s", SERVICE,
    "-a", username(),
    "-w",
  ]);
  const payload = JSON.parse(stdout.trim()) as CredentialPayload;
  if (!payload?.claudeAiOauth) throw new Error("Keychain item has no claudeAiOauth entry");
  return payload;
}

const darwin: PlatformOps = {
  async readOAuthCredentials(): Promise<OAuthCredentials> {
    return (await darwin.readCredentialPayload()).claudeAiOauth;
  },

  async readCredentialPayload(): Promise<CredentialPayload> {
    try {
      return await readKeychainPayload();
    } catch (err) {
      // Some installs (CLAUDE_CONFIG_DIR, older builds) use the plaintext file.
      if (credentialsFileExists()) return readPayloadFromFile();
      throw err;
    }
  },

  async credentialsExist(): Promise<boolean> {
    const inKeychain = await execFileAsync("security", [
      "find-generic-password",
      "-s", SERVICE,
      "-a", username(),
    ])
      .then(() => true)
      .catch(() => false);
    return inKeychain || credentialsFileExists();
  },

  async writeOAuthCredentials(payload: CredentialPayload): Promise<void> {
    await execFileAsync("security", [
      "add-generic-password",
      "-s", SERVICE,
      "-a", username(),
      "-w", JSON.stringify(payload),
      "-U",
    ]);
  },

  async getSystemName(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("scutil", ["--get", "ComputerName"]);
      return stdout.trim() || os.hostname();
    } catch {
      return os.hostname();
    }
  },
};

export default darwin;
