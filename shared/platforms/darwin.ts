import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import type { CredentialPayload, OAuthCredentials, PlatformOps } from "./types.js";

const execFileAsync = promisify(execFile);
const SERVICE = "Claude Code-credentials";

function username() {
  return os.userInfo().username;
}

const darwin: PlatformOps = {
  async readOAuthCredentials(): Promise<OAuthCredentials> {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", SERVICE,
      "-a", username(),
      "-w",
    ]);
    const payload: CredentialPayload = JSON.parse(stdout.trim());
    return payload.claudeAiOauth;
  },

  async credentialsExist(): Promise<boolean> {
    return execFileAsync("security", [
      "find-generic-password",
      "-s", SERVICE,
      "-a", username(),
    ])
      .then(() => true)
      .catch(() => false);
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
      return stdout.trim();
    } catch {
      return os.hostname();
    }
  },
};

export default darwin;
