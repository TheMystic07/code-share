import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import {
  CODEX_PLACEHOLDER,
  type CodexAuthFile,
  codexIdentity,
  readCodexAuth,
  unsignedJwt,
  writeCodexAuth,
} from "@shared/codex/store";
import { logger } from "./logger";
import { run } from "./proc";
import type { SharerAccount, SharerSubscription } from "./types";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";

// ── Binary discovery / install / update ──────────────────────────────────────

/** Resolves the `codex` executable (handles Windows .cmd/.exe shims). */
export async function findCodex(): Promise<string | null> {
  const which = IS_WIN ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(which, ["codex"]);
    const candidates = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (candidates.length === 0) return null;
    if (!IS_WIN) return candidates[0]!;
    return candidates.find((c) => /\.exe$/i.test(c)) ?? candidates[0]!;
  } catch {}
  return null;
}

async function codexVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      timeout: 15_000,
      shell: IS_WIN && /\.(cmd|bat)$/i.test(bin),
    });
    // "codex-cli 0.153.3"
    const parts = stdout.trim().split(/\s+/);
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(IS_WIN ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function installCodex(): Promise<boolean> {
  if (await hasCommand("npm")) {
    const code = await run(IS_WIN ? "npm.cmd" : "npm", ["install", "-g", "@openai/codex@latest"], {
      timeout: 600_000,
      shell: IS_WIN,
    });
    if (code === 0 && (await findCodex())) return true;
  }
  if (process.platform === "darwin" && (await hasCommand("brew"))) {
    const code = await run("brew", ["install", "--cask", "codex"], { timeout: 600_000 });
    if (code === 0 && (await findCodex())) return true;
  }
  return false;
}

/**
 * Keeps the receiver's Codex CLI current before every launch (and installs it
 * when missing). Skip with `--no-update` or CODE_CONNECT_NO_UPDATE=1.
 */
export async function ensureCodexUpToDate(skip: boolean): Promise<void> {
  if (skip || process.env.CODE_CONNECT_NO_UPDATE === "1") return;

  let bin = await findCodex();
  if (!bin) {
    p.log.warn("Codex CLI is not installed — installing it now (npm install -g @openai/codex).");
    const ok = await installCodex();
    bin = await findCodex();
    if (!ok || !bin) {
      p.log.error("Automatic install failed. Install Codex manually (npm install -g @openai/codex) and re-run code-connect.");
      return;
    }
    p.log.success(`Codex installed (${(await codexVersion(bin)) ?? "unknown version"}).`);
    return;
  }

  const before = await codexVersion(bin);
  p.log.step(`Checking for Codex updates (current: ${before ?? "unknown"})…`);
  // `codex update` knows how the binary was installed (npm / brew / binary)
  // and runs the matching updater. Bounded so a stuck updater never blocks.
  const code = await run(bin, ["update"], {
    timeout: 240_000,
    shell: IS_WIN && /\.(cmd|bat)$/i.test(bin),
  });
  const after = await codexVersion((await findCodex()) ?? bin);
  if (code !== 0) {
    p.log.warn(`Codex update did not complete (exit ${code}) — continuing with ${after ?? before ?? "current version"}.`);
    logger.warn("codex update failed", { code, before, after });
  } else if (after && before && after !== before) {
    p.log.success(`Codex updated ${before} → ${after}.`);
  } else {
    p.log.info(`Codex is up to date (${after ?? before ?? "unknown"}).`);
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────

// The receiver never holds a real token: the sharer's MITM replaces the
// Authorization / ChatGPT-Account-ID headers. This placeholder auth.json only
// exists so Codex believes it is signed in with ChatGPT. The id_token carries
// the sharer's plan type so Codex shows the same plan/limits UI.
function placeholderAuth(sub: SharerSubscription | null, account: SharerAccount | null): CodexAuthFile {
  const now = new Date();
  const exp = 4102444800; // 2100-01-01 — never triggers a refresh
  const email = account?.emailAddress || "code-share@localhost";
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: unsignedJwt({
        email,
        "https://api.openai.com/profile": { email },
        "https://api.openai.com/auth": {
          chatgpt_plan_type: sub?.subscriptionType || "plus",
          chatgpt_account_id: CODEX_PLACEHOLDER,
          chatgpt_user_id: "code-share",
        },
        exp,
      }),
      access_token: unsignedJwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: CODEX_PLACEHOLDER } }),
      refresh_token: CODEX_PLACEHOLDER,
      account_id: CODEX_PLACEHOLDER,
    },
    // Codex forces a refresh when this is older than 8 days — rewritten on every launch.
    last_refresh: now.toISOString(),
  };
}

export async function ensureCodexCredentials(
  sub: SharerSubscription | null,
  account: SharerAccount | null,
): Promise<void> {
  const desired = placeholderAuth(sub, account);

  let existing = null;
  try {
    existing = await readCodexAuth();
  } catch (err) {
    logger.warn("Could not inspect existing Codex credentials", err);
  }

  if (existing) {
    const isPlaceholder = existing.auth.tokens?.refresh_token === CODEX_PLACEHOLDER;
    if (!isPlaceholder) {
      // A real ChatGPT login stays untouched; the proxy swaps the token anyway.
      if (existing.auth.auth_mode === "apikey" || (!existing.auth.tokens && existing.auth.OPENAI_API_KEY)) {
        p.log.warn(
          "Codex on this machine is signed in with an API key. Run 'codex logout' and re-run code-connect so the shared ChatGPT login is used.",
        );
      }
      return;
    }
    // Keep our placeholder fresh (plan type, email, last_refresh).
    await writeCodexAuth({ auth: { ...existing.auth, ...desired }, store: existing.store });
    logger.info("Refreshed placeholder Codex credentials", {
      plan: codexIdentity(desired.tokens).planType,
    });
    return;
  }

  p.log.warn("No Codex login found. Codex needs one to think you're signed in.");
  const confirm = await p.confirm({
    message: "Create placeholder Codex credentials so it launches without a login prompt?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.log.warn("Skipping credentials setup. Codex may ask you to sign in.");
    return;
  }

  await writeCodexAuth({ auth: desired, store: "file" });
  p.log.success("Placeholder Codex credentials created.");
}

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * Environment for the `codex` child. Codex (Rust/reqwest) honours HTTPS_PROXY
 * for both HTTP and websocket traffic and tunnels TLS to an https:// proxy.
 * CODEX_CA_CERTIFICATE *adds* our session CA; SSL_CERT_FILE would *replace*
 * the system roots, so it is deliberately not set.
 */
export function codexEnv(httpProxyUrl: string, tmpCert: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTPS_PROXY: httpProxyUrl,
    HTTP_PROXY: httpProxyUrl,
    CODEX_CA_CERTIFICATE: tmpCert,
  };
  delete env.SSL_CERT_FILE;
  // An API key in the environment forces API-key mode and bypasses the shared login.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.CODEX_API_KEY;
  return env;
}

export function codexInstallHint(): string {
  return "Install it with: npm install -g @openai/codex" + (process.platform === "darwin" ? "   (or: brew install --cask codex)" : "");
}

