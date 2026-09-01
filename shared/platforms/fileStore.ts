import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CredentialPayload, OAuthCredentials } from "./types";

/** Claude Code's config dir — honours CLAUDE_CONFIG_DIR like the CLI does. */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? override : path.join(os.homedir(), ".claude");
}

export function credentialsPath(): string {
  return path.join(claudeConfigDir(), ".credentials.json");
}

export async function readPayloadFromFile(): Promise<CredentialPayload> {
  const raw = await fs.promises.readFile(credentialsPath(), "utf8");
  const payload = JSON.parse(raw) as CredentialPayload;
  if (!payload || typeof payload !== "object" || !payload.claudeAiOauth) {
    throw new Error("Credential file has no claudeAiOauth entry");
  }
  return payload;
}

export async function readOAuthFromFile(): Promise<OAuthCredentials> {
  return (await readPayloadFromFile()).claudeAiOauth;
}

export function credentialsFileExists(): boolean {
  return fs.existsSync(credentialsPath());
}

/** Atomic write (tmp + rename) so a concurrent Claude Code read never sees a torn file. */
export async function writePayloadToFile(payload: CredentialPayload): Promise<void> {
  const target = credentialsPath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  });
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    // Windows can refuse rename-over-open-file; fall back to a direct write.
    await fs.promises.rm(tmp, { force: true });
    if (process.platform !== "win32") throw err;
    await fs.promises.writeFile(target, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
  }
}
