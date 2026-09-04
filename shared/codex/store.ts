import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Codex CLI keeps its ChatGPT login in $CODEX_HOME/auth.json (default
// ~/.codex/auth.json). Structure mirrors codex-rs `AuthDotJson`; every key we
// don't understand is preserved verbatim on write.

/** Marker used for the receiver's placeholder login. Never a real token. */
export const CODEX_PLACEHOLDER = "code-share-placeholder";

export interface CodexTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
  [key: string]: unknown;
}

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  /** ISO-8601 — codex refreshes proactively when this is older than 8 days */
  last_refresh?: string;
  [key: string]: unknown;
}

/** Non-secret claims codex reads from the id_token. */
export interface CodexIdentity {
  email: string | null;
  planType: string | null;
  accountId: string | null;
}

export function codexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override ? override : path.join(os.homedir(), ".codex");
}

export function codexAuthPath(): string {
  return path.join(codexHome(), "auth.json");
}

// ── JWT helpers (no signature verification — same as codex itself) ───────────

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Epoch ms of the access token's `exp` claim, or null when absent. */
export function jwtExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)?.["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

export function codexIdentity(tokens: CodexTokens | undefined): CodexIdentity {
  const empty: CodexIdentity = { email: null, planType: null, accountId: null };
  if (!tokens?.id_token) return empty;
  const payload = decodeJwtPayload(tokens.id_token);
  if (!payload) return empty;
  const auth = (payload[AUTH_CLAIM] ?? {}) as Record<string, unknown>;
  const profile = (payload[PROFILE_CLAIM] ?? {}) as Record<string, unknown>;
  const email =
    (typeof payload["email"] === "string" && payload["email"]) ||
    (typeof profile["email"] === "string" && profile["email"]) ||
    null;
  const planType = typeof auth["chatgpt_plan_type"] === "string" ? auth["chatgpt_plan_type"] : null;
  const accountId =
    (typeof tokens.account_id === "string" && tokens.account_id) ||
    (typeof auth["chatgpt_account_id"] === "string" && auth["chatgpt_account_id"]) ||
    null;
  return { email, planType, accountId };
}

/** Builds an unsigned JWT (`alg: none`) — only used for receiver placeholders. */
export function unsignedJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.x`;
}

// ── File store ───────────────────────────────────────────────────────────────

export function codexAuthFileExists(): boolean {
  return fs.existsSync(codexAuthPath());
}

export async function readCodexAuthFile(): Promise<CodexAuthFile | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(codexAuthPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("auth.json is not an object");
  return parsed as CodexAuthFile;
}

/** Atomic write (tmp + rename) so a concurrent codex read never sees a torn file. */
export async function writeCodexAuthFile(auth: CodexAuthFile): Promise<void> {
  const target = codexAuthPath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const data = JSON.stringify(auth, null, 2);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, data, { mode: 0o600 });
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    if (process.platform !== "win32") throw err;
    await fs.promises.writeFile(target, data, { mode: 0o600 });
  }
}

// ── macOS keychain store (codex `cli_auth_credentials_store = "keyring"`) ────
// Service "Codex Auth", account "cli|<sha256(canonical CODEX_HOME)[0..16]>".

const KEYCHAIN_SERVICE = "Codex Auth";

function keychainAccount(): string {
  const home = codexHome();
  let canonical = home;
  try {
    canonical = fs.realpathSync(home);
  } catch {}
  const hex = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return `cli|${hex.slice(0, 16)}`;
}

async function readKeychain(): Promise<CodexAuthFile | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", keychainAccount(),
      "-w",
    ]);
    const parsed = JSON.parse(stdout.trim()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CodexAuthFile) : null;
  } catch {
    return null;
  }
}

async function writeKeychain(auth: CodexAuthFile): Promise<void> {
  await execFileAsync("security", [
    "add-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", keychainAccount(),
    "-w", JSON.stringify(auth),
    "-U",
  ]);
}

export type CodexStoreKind = "file" | "keychain";

export interface CodexAuthRecord {
  auth: CodexAuthFile;
  /** Where it came from — writes go back to the same place. */
  store: CodexStoreKind;
}

function hasChatGptTokens(auth: CodexAuthFile | null): auth is CodexAuthFile & { tokens: CodexTokens } {
  return !!auth?.tokens?.access_token && !!auth.tokens.refresh_token;
}

/**
 * Reads the codex login wherever it lives: auth.json first (codex's default),
 * then the macOS keychain. Returns null when there is no ChatGPT login.
 */
export async function readCodexAuth(): Promise<CodexAuthRecord | null> {
  const file = await readCodexAuthFile().catch(() => null);
  if (hasChatGptTokens(file)) return { auth: file, store: "file" };
  const kc = await readKeychain();
  if (hasChatGptTokens(kc)) return { auth: kc, store: "keychain" };
  return null;
}

export async function writeCodexAuth(record: CodexAuthRecord): Promise<void> {
  if (record.store === "keychain") return writeKeychain(record.auth);
  return writeCodexAuthFile(record.auth);
}

/** True when a ChatGPT login (not an API key) is available on this machine. */
export async function codexCredentialsExist(): Promise<boolean> {
  return (await readCodexAuth()) !== null;
}
