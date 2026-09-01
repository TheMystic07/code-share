import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import type { CredentialPayload } from "@shared/platforms";
import { DEFAULT_SCOPES } from "@shared/oauth";
import { apiFetch } from "./fetch";
import { logger } from "./logger";
import type { SharerAccount, SharerSubscription } from "./types";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";

// ── Claude Code config (.claude.json) ─────────────────────────────────────────

function claudeJsonPath(): string {
  // Claude Code keeps .claude.json next to the config dir when CLAUDE_CONFIG_DIR is set.
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? path.join(override, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

function readClaudeJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeClaudeJson(config: Record<string, unknown>): void {
  const file = claudeJsonPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Makes sure Claude Code launches straight into the prompt on a machine that
 * has never logged in: marks onboarding as done and, on Windows, pins the
 * credential backend to the plaintext file we write (Claude Code may otherwise
 * switch to Windows Credential Manager via a feature flag and find nothing).
 */
export function ensureOnboarding() {
  const config = readClaudeJson();
  let changed = false;

  if (config["hasCompletedOnboarding"] !== true) {
    p.log.info("Onboarding not completed — marking it done so Claude launches directly.");
    config["hasCompletedOnboarding"] = true;
    changed = true;
  }

  if (IS_WIN) {
    const gb = (config["cachedGrowthBookFeatures"] ?? {}) as Record<string, unknown>;
    if (gb["tengu_windows_credman"] === true) {
      gb["tengu_windows_credman"] = false;
      config["cachedGrowthBookFeatures"] = gb;
      changed = true;
    }
  }

  if (changed) writeClaudeJson(config);
}

// ── Credentials ───────────────────────────────────────────────────────────────

// The receiver never holds a real token: the sharer's MITM replaces the
// Authorization header. These placeholders only exist so Claude Code believes
// it is logged in. subscriptionType/rateLimitTier mirror the sharer's plan so
// Claude Code offers the same model list and modes.
function placeholderCredentials(sub: SharerSubscription | null): CredentialPayload {
  return {
    claudeAiOauth: {
      accessToken: "claude-share-placeholder",
      refreshToken: "",
      expiresAt: 4102444800000, // 2100-01-01 — never triggers a refresh
      scopes: DEFAULT_SCOPES,
      subscriptionType: sub?.subscriptionType || "max",
      rateLimitTier: sub?.rateLimitTier || "default_claude_max_20x",
    },
  };
}

export async function ensureCredentials(sub: SharerSubscription | null) {
  const desired = placeholderCredentials(sub);

  if (await platform().credentialsExist()) {
    // Keep a real login untouched; only refresh *our* placeholder when the plan changed.
    try {
      const existing = await platform().readCredentialPayload();
      const cur = existing.claudeAiOauth;
      const isPlaceholder = cur.accessToken === "claude-share-placeholder" || cur.accessToken === "1234";
      if (!isPlaceholder) return;
      if (
        cur.subscriptionType !== desired.claudeAiOauth.subscriptionType ||
        cur.rateLimitTier !== desired.claudeAiOauth.rateLimitTier ||
        cur.accessToken !== desired.claudeAiOauth.accessToken
      ) {
        await platform().writeOAuthCredentials({ ...existing, ...desired });
        logger.info("Updated placeholder credentials to match sharer plan");
      }
    } catch (err) {
      logger.warn("Could not inspect existing credentials", err);
    }
    return;
  }

  p.log.warn("No Claude credentials found. Claude needs this to think you're logged in.");
  const confirm = await p.confirm({
    message: "Create placeholder credentials so Claude launches without a login prompt?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.log.warn("Skipping credentials setup. Claude may redirect you to login.");
    return;
  }

  await platform().writeOAuthCredentials(desired);
  p.log.success("Placeholder credentials created.");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolves the `claude` executable (handles Windows .cmd/.exe shims). */
export async function findClaude(): Promise<string | null> {
  const which = IS_WIN ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(which, ["claude"]);
    const candidates = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (candidates.length === 0) return null;
    if (!IS_WIN) return candidates[0]!;
    // Prefer a real executable over the npm .cmd shim (cleaner signal handling).
    return candidates.find((c) => /\.exe$/i.test(c)) ?? candidates[0]!;
  } catch {}
  if (IS_WIN) {
    const local = path.join(os.homedir(), ".local", "bin", "claude.exe");
    if (fs.existsSync(local)) return local;
  }
  return null;
}

export async function checkClaudeInstalled(): Promise<boolean> {
  return (await findClaude()) !== null;
}

export async function sessionPost(
  serverUrl: string,
  endpoint: string,
  body: Record<string, string>,
  caPem?: string,
  proxyAuth?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (proxyAuth) headers["Proxy-Authorization"] = proxyAuth;
  const r = await apiFetch(`${serverUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: 5_000,
    ca: caPem,
  });
  return r.ok ? (r.json() as Promise<Record<string, unknown>>) : {};
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: {
    systemName: string;
    id: string;
    proxyUser: string;
    proxyPass: string;
    sharerSubscription?: SharerSubscription | null;
  },
  claudeArgs: string[] = [],
  sharerAccount: SharerAccount | null = null,
) {
  const claudeBin = await findClaude();
  if (!claudeBin) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info(
      IS_WIN
        ? "Install it with: irm https://claude.ai/install.ps1 | iex   (or: npm install -g @anthropic-ai/claude-code)"
        : "Install it with: curl -fsSL https://claude.ai/install.sh | bash   (or: npm install -g @anthropic-ai/claude-code)",
    );
    process.exit(1);
  }

  ensureOnboarding();
  await ensureCredentials(meta.sharerSubscription ?? null);

  if (sharerAccount) {
    p.log.info(`Account: ${sharerAccount.displayName} (${sharerAccount.emailAddress})`);
  }

  const certDir = path.join(os.homedir(), ".claude-share", "tmp");
  fs.mkdirSync(certDir, { recursive: true });
  const tmpCert = path.join(certDir, `ca-${process.pid}-${Date.now()}.pem`);
  fs.writeFileSync(tmpCert, caPem, { mode: 0o600 });

  const proxyAuth =
    "Basic " + Buffer.from(`${meta.proxyUser}:${meta.proxyPass}`).toString("base64");

  // Register this Claude session with the sharer
  let sessionId: string | null = null;
  try {
    const res = await sessionPost(proxyUrl, "/session/start", { machineId: meta.id }, caPem, proxyAuth);
    sessionId = (res["sessionId"] as string) ?? null;
    if (!sessionId) logger.warn("session/start returned no sessionId", { machineId: meta.id });
  } catch (err) {
    logger.error("session/start failed", err);
  }

  // 30-second heartbeat so sharer sees lastActiveAt update
  const heartbeat = sessionId
    ? setInterval(() => {
        void sessionPost(
          proxyUrl,
          "/session/heartbeat",
          { machineId: meta.id, sessionId: sessionId! },
          caPem,
          proxyAuth,
        ).catch(() => {});
      }, 30_000)
    : null;

  p.log.success("\x1b[32mLaunching Claude...\x1b[0m");
  p.outro("");

  const startTime = Date.now();

  // Proxy URL keeps https:// — the TLS terminator on the sharer routes CONNECT
  // requests to the MITM proxy after decryption, so the outer connection is
  // encrypted and proxy credentials are never sent in cleartext over the network.
  const parsedProxy = new URL(proxyUrl);
  parsedProxy.username = encodeURIComponent(meta.proxyUser);
  parsedProxy.password = encodeURIComponent(meta.proxyPass);
  const httpProxyUrl = parsedProxy.toString();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTPS_PROXY: httpProxyUrl,
    HTTP_PROXY: httpProxyUrl,
    NODE_EXTRA_CA_CERTS: tmpCert,
    SSL_CERT_FILE: tmpCert,
    CURL_CA_BUNDLE: tmpCert,
  };
  // Any stale auth env would take precedence over the placeholder login and
  // bypass the proxy's model discovery — make sure it's clear.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  const useShell = IS_WIN && /\.(cmd|bat)$/i.test(claudeBin);
  const child = spawn(useShell ? `"${claudeBin}"` : claudeBin, claudeArgs, {
    stdio: "inherit",
    env,
    shell: useShell,
    windowsHide: false,
  });

  let exiting = false;
  async function cleanupAndExit(code: number | null) {
    if (exiting) return;
    exiting = true;
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      await sessionPost(proxyUrl, "/session/end", { machineId: meta.id, sessionId }, caPem, proxyAuth).catch(
        () => {},
      );
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    p.log.info(`Session ended. Duration: ${mins}m ${secs}s`);
    process.exit(code ?? 0);
  }

  child.on("exit", (code) => {
    void cleanupAndExit(code);
  });

  child.on("error", (err) => {
    logger.error("Failed to launch claude process", err);
    p.log.error(`Failed to launch claude: ${err.message}`);
    p.log.warn("Is 'claude' installed? See https://docs.claude.com/en/docs/claude-code/setup");
    void cleanupAndExit(1);
  });

  // On Windows Ctrl+C is delivered to the whole console group, so the child
  // already gets it; forwarding is only needed on POSIX.
  if (!IS_WIN) {
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  } else {
    process.on("SIGINT", () => {});
  }
}
