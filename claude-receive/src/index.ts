#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { logger } from "./logger.js";

// ── Types shared with claude-share ──────────────────────────────────────────

interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
}

interface ConnectionFile {
  publicServerUrl: string | null;
  lanServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601
  caPem: string;
  sharerAccount: SharerAccount | null;
}

interface SavedConnection {
  id: string;
  name: string;
  serverUrl: string;
  sessionId: string;
  sharedUntil: string; // ISO-8601 — used to prune expired connections on startup
  caPem: string;
  savedAt: string;
  sharerAccount: SharerAccount | null;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_SHARE_DIR = path.join(os.homedir(), ".claude-share");
const CONNECTIONS_DIR = path.join(CLAUDE_SHARE_DIR, "connections");
const ACCOUNT_BACKUP_FILE = path.join(CLAUDE_SHARE_DIR, "account-backup.json");
const CONFIG_FILE = path.join(CLAUDE_SHARE_DIR, "config.json");

function ensureConnectionsDir() {
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true });
}

// ── Device config ─────────────────────────────────────────────────────────────

interface ReceiverConfig {
  deviceName: string;
}

function readConfig(): ReceiverConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as ReceiverConfig;
  } catch {
    return null;
  }
}

function writeConfig(config: ReceiverConfig): void {
  fs.mkdirSync(CLAUDE_SHARE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

async function getDeviceName(): Promise<string> {
  const saved = readConfig();
  if (saved?.deviceName) return saved.deviceName;

  let name: string;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("scutil", [
        "--get",
        "ComputerName",
      ]);
      name = stdout.trim();
    } else {
      const { stdout } = await execFileAsync("hostname");
      name = stdout.trim();
    }
  } catch {
    name = os.hostname();
  }

  writeConfig({ deviceName: name });
  return name;
}

function connectionPath(id: string) {
  return path.join(CONNECTIONS_DIR, `${id}.json`);
}

function loadConnections(): SavedConnection[] {
  ensureConnectionsDir();
  return fs
    .readdirSync(CONNECTIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(CONNECTIONS_DIR, f), "utf8"),
        ) as SavedConnection;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SavedConnection[];
}

function pruneExpiredConnections(): void {
  ensureConnectionsDir();
  const now = Date.now();
  for (const file of fs
    .readdirSync(CONNECTIONS_DIR)
    .filter((f) => f.endsWith(".json"))) {
    const filePath = path.join(CONNECTIONS_DIR, file);
    try {
      const c = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as Partial<SavedConnection>;
      // Remove if sharedUntil is present and in the past; leave legacy entries without it alone
      if (c.sharedUntil && new Date(c.sharedUntil).getTime() < now) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Corrupt file — remove it too
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }
}

function findConnectionByServerUrl(serverUrl: string): SavedConnection | null {
  const all = loadConnections().filter((c) => c.serverUrl === serverUrl);
  if (all.length === 0) return null;
  // Most recently saved wins
  return all.sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  )[0];
}

// ── Base58 decode ────────────────────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fromBase58(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(20, "0"); // at least 10 bytes
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

// ── Decryption (mirrors session/manager.ts in claude-share) ─────────────────

function decryptBlob(blob: string, pairingCode: string): ConnectionFile {
  // Pairing code is the full 32-byte session key encoded in base58
  const codeBytes = fromBase58(pairingCode);
  if (codeBytes.length < 32) throw new Error("Pairing code too short");
  const key = codeBytes.slice(0, 32);

  const nonceHex = blob.slice(0, 48);
  const ctHex = blob.slice(48);
  const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
  const ciphertext = Uint8Array.from(Buffer.from(ctHex, "hex"));

  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionFile;
}

// ── Connect URL ───────────────────────────────────────────────────────────────
// Format: http://host:port/connect/<pairingCode>
// The server does not need to handle this path — it's parsed client-side only.

function parseConnectUrl(
  url: string,
): { serverUrl: string; pairingCode: string } | null {
  const match = url.match(/^(https?:\/\/.+?)\/connect\/([A-Za-z0-9]+)$/);
  if (!match) return null;
  return { serverUrl: match[1], pairingCode: match[2] };
}

// ── Health check ─────────────────────────────────────────────────────────────

interface HealthResult {
  alive: boolean;
  sessionId: string | null;
}

async function checkHealth(serverUrl: string): Promise<HealthResult> {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as {
      ok: boolean;
      sessionActive: boolean;
      sessionId?: string;
    };
    return {
      alive: body.ok && body.sessionActive,
      sessionId: body.sessionId ?? null,
    };
  } catch {
    return { alive: false, sessionId: null };
  }
}

// ── Pair flow ────────────────────────────────────────────────────────────────

async function pairFlow(
  prefill?: { serverUrl: string; pairingCode: string },
  claudeArgs: string[] = [],
) {
  p.intro("claude-receive — pair with a new sharer");

  let serverUrl: string;
  let pairingCode: string;

  if (prefill) {
    serverUrl = prefill.serverUrl;
    pairingCode = prefill.pairingCode;
    p.log.info(`Connecting to ${serverUrl}`);
  } else {
    const input = await p.text({
      message: "Connect link or sharer URL:",
      placeholder: "http://192.168.x.x:8080/connect/CODE",
      validate: (v) => (v?.startsWith("http") ? undefined : "Must be a URL"),
    });
    if (p.isCancel(input)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const parsed = parseConnectUrl((input as string).trim());
    if (parsed) {
      serverUrl = parsed.serverUrl;
      pairingCode = parsed.pairingCode;
    } else {
      serverUrl = (input as string).trim();
      const codeInput = await p.text({
        message: "Pairing code (from their terminal):",
        validate: (v) => ((v?.trim().length ?? 0) > 0 ? undefined : "Required"),
      });
      if (p.isCancel(codeInput)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      pairingCode = (codeInput as string).trim();
    }
  }

  const name = await getDeviceName();
  p.log.info(`Connecting as "${name}"`);

  const spin = p.spinner();
  spin.start("Pairing...");

  let blob: string;
  let connectionId: string;
  try {
    const res = await fetch(`${serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode, name }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      spin.stop("Failed.");
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string } | null;
        if (body?.error) message = body.error;
      } catch {}
      logger.error(`Pairing failed: ${message}`, { serverUrl });
      p.log.error(message);
      process.exit(1);
    }
    const data = (await res.json()) as { blob: string; machineId: string };
    blob = data.blob;
    connectionId = data.machineId;
  } catch (err) {
    spin.stop("Network error.");
    logger.error("Pairing network error", err);
    p.log.error((err as Error).message);
    process.exit(1);
  }

  let file: ConnectionFile;
  try {
    file = decryptBlob(blob, pairingCode);
  } catch {
    spin.stop("Decryption failed.");
    p.log.error("Wrong pairing code or corrupted response.");
    process.exit(1);
  }

  spin.stop("Paired successfully.");

  ensureConnectionsDir();
  const saved: SavedConnection = {
    id: connectionId,
    name: name as string,
    serverUrl,
    sessionId: file.sessionId,
    sharedUntil: file.sharedUntil,
    caPem: file.caPem,
    savedAt: new Date().toISOString(),
    sharerAccount: file.sharerAccount ?? null,
  };
  fs.writeFileSync(
    connectionPath(connectionId),
    JSON.stringify(saved, null, 2),
  );

  await launchClaude(
    serverUrl,
    file.caPem,
    saved,
    claudeArgs,
    file.sharerAccount ?? null,
  );
}

// ── Reconnect flow ────────────────────────────────────────────────────────────

async function reconnectFlow(uuid?: string, claudeArgs: string[] = []) {
  const connections = loadConnections();

  if (connections.length === 0) {
    p.log.warn("No saved connections. Run without flags to pair.");
    process.exit(0);
  }

  let chosen: SavedConnection;

  if (uuid) {
    const match = connections.find((c) => c.id.startsWith(uuid));
    if (!match) {
      p.log.error(`No connection matching ${uuid}`);
      process.exit(1);
    }
    chosen = match;
  } else {
    p.intro("claude-receive — reconnect");
    const pick = await p.select({
      message: "Choose a connection:",
      options: connections.map((c) => ({
        value: c.id,
        label: `${c.name} — ${c.serverUrl}`,
        hint: `saved ${new Date(c.savedAt).toLocaleDateString()}`,
      })),
    });
    if (p.isCancel(pick)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    chosen = connections.find((c) => c.id === pick)!;
  }

  const spin = p.spinner();
  spin.start(`Checking ${chosen.serverUrl}...`);
  const { alive } = await checkHealth(chosen.serverUrl);
  if (!alive) {
    spin.stop("Server offline or session expired.");
    process.exit(1);
  }
  spin.stop("Server is alive.");

  await launchClaude(
    chosen.serverUrl,
    chosen.caPem,
    chosen,
    claudeArgs,
    chosen.sharerAccount ?? null,
  );
}

// ── List flow ────────────────────────────────────────────────────────────────

async function listFlow() {
  const connections = loadConnections();
  if (connections.length === 0) {
    console.log("No saved connections.");
    return;
  }

  console.log("\nSaved connections:\n");
  for (const c of connections) {
    const { alive } = await checkHealth(c.serverUrl);
    const status = alive
      ? "\x1b[32m● online\x1b[0m"
      : "\x1b[90m○ offline\x1b[0m";
    console.log(`  ${status}  ${c.name}  ${c.serverUrl}`);
    console.log(`           id: ${c.id}`);
    console.log(`           saved: ${new Date(c.savedAt).toLocaleString()}\n`);
  }
}

// ── Launch claude ─────────────────────────────────────────────────────────────

function ensureOnboarding() {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {}

  if (config["hasCompletedOnboarding"] !== true) {
    p.log.info(
      "Onboarding not completed — marking it done so Claude launches directly.",
    );
    config["hasCompletedOnboarding"] = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }
}

const PLACEHOLDER_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "claude-relay",
    refreshToken: "",
    expiresAt: 4102444800000,
    scopes: [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
};

async function ensureCredentials() {
  if (process.platform === "linux") {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    if (fs.existsSync(credPath)) return;

    p.log.warn(
      "No ~/.claude/.credentials.json found. Claude needs this to think you're logged in.",
    );
    const confirm = await p.confirm({
      message:
        "Create a placeholder credentials file so Claude launches without a login prompt?",
      initialValue: true,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.log.warn(
        "Skipping credentials setup. Claude may redirect you to login.",
      );
      return;
    }

    fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify(PLACEHOLDER_CREDENTIALS, null, 2),
      { mode: 0o600 },
    );
    p.log.success(
      "Created ~/.claude/.credentials.json with placeholder credentials.",
    );
  } else if (process.platform === "darwin") {
    const username = os.userInfo().username;
    const service = "Claude Code-credentials";

    // Check if an entry already exists
    const exists = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      username,
    ])
      .then(() => true)
      .catch(() => false);

    if (exists) return;

    p.log.warn(
      "No Claude credentials found in Keychain. Claude needs this to think you're logged in.",
    );
    const confirm = await p.confirm({
      message:
        "Add a placeholder Keychain entry so Claude launches without a login prompt?",
      initialValue: true,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.log.warn(
        "Skipping credentials setup. Claude may redirect you to login.",
      );
      return;
    }

    await execFileAsync("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      username,
      "-w",
      JSON.stringify(PLACEHOLDER_CREDENTIALS),
      "-U",
    ]);
    p.log.success("Added placeholder credentials to Keychain.");
  }
}

function patchClaudeJson(
  sharerAccount: SharerAccount,
): Record<string, unknown> | null {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  try {
    const config = JSON.parse(
      fs.readFileSync(claudeJsonPath, "utf8"),
    ) as Record<string, unknown>;
    const original = config["oauthAccount"] ?? null;

    // Persist backup so --cleanup can restore even if the process crashed
    fs.mkdirSync(path.join(os.homedir(), ".claude-share"), { recursive: true });
    fs.writeFileSync(
      ACCOUNT_BACKUP_FILE,
      JSON.stringify({ oauthAccount: original }, null, 2),
      { mode: 0o600 },
    );

    config["oauthAccount"] = {
      ...(typeof original === "object" && original !== null ? original : {}),
      emailAddress: sharerAccount.emailAddress,
      displayName: sharerAccount.displayName,
      organizationName: sharerAccount.organizationName,
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    return original as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

function restoreClaudeJson(original: Record<string, unknown> | null): void {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  try {
    const config = JSON.parse(
      fs.readFileSync(claudeJsonPath, "utf8"),
    ) as Record<string, unknown>;
    if (original === null) {
      delete config["oauthAccount"];
    } else {
      config["oauthAccount"] = original;
    }
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    try {
      fs.unlinkSync(ACCOUNT_BACKUP_FILE);
    } catch {}
  } catch {}
}

function cleanupFlow(): void {
  if (!fs.existsSync(ACCOUNT_BACKUP_FILE)) {
    console.log("Nothing to clean up — no account backup found.");
    process.exit(0);
  }

  try {
    const backup = JSON.parse(fs.readFileSync(ACCOUNT_BACKUP_FILE, "utf8")) as {
      oauthAccount: Record<string, unknown> | null;
    };
    restoreClaudeJson(backup.oauthAccount);
    console.log("Restored original oauthAccount in ~/.claude.json.");
  } catch (err) {
    console.error("Cleanup failed:", (err as Error).message);
    process.exit(1);
  }

  process.exit(0);
}

async function checkClaudeInstalled(): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "which";
  return execFileAsync(which, ["claude"])
    .then(() => true)
    .catch(() => false);
}

async function sessionPost(
  serverUrl: string,
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const r = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return r.ok ? (r.json() as Promise<Record<string, unknown>>) : {};
}

async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: { name: string; id: string; serverUrl: string },
  claudeArgs: string[] = [],
  sharerAccount: SharerAccount | null = null,
) {
  if (!(await checkClaudeInstalled())) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info("Install it with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  ensureOnboarding();
  await ensureCredentials();

  const originalAccount = sharerAccount ? patchClaudeJson(sharerAccount) : null;
  if (sharerAccount) {
    p.log.info(
      `Connecting as ${sharerAccount.displayName} (${sharerAccount.emailAddress})`,
    );
  }

  const tmpCert = path.join(os.tmpdir(), `claude-share-ca-${Date.now()}.pem`);
  fs.writeFileSync(tmpCert, caPem, { mode: 0o600 });

  // Register this Claude session with the sharer
  let sessionId: string | null = null;
  try {
    const res = await sessionPost(meta.serverUrl, "/session/start", {
      machineId: meta.id,
    });
    sessionId = (res["sessionId"] as string) ?? null;
    if (!sessionId)
      logger.warn("session/start returned no sessionId", {
        machineId: meta.id,
      });
  } catch (err) {
    logger.error("session/start failed", err);
  }

  // 30-second heartbeat so sharer sees lastActiveAt update
  const heartbeat = sessionId
    ? setInterval(() => {
        void sessionPost(meta.serverUrl, "/session/heartbeat", {
          machineId: meta.id,
          sessionId: sessionId!,
        }).catch(() => {});
      }, 30_000)
    : null;

  p.log.success(
    `Launching Claude as ${meta.name}. All API calls proxied through sharer.`,
  );
  p.log.info(`Proxy: ${proxyUrl}`);
  if (claudeArgs.length > 0) p.log.info(`Extra args: ${claudeArgs.join(" ")}`);
  p.log.info("Press Ctrl+C to exit and disconnect.");
  p.outro("");

  const startTime = Date.now();

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NODE_EXTRA_CA_CERTS: tmpCert,
      SSL_CERT_FILE: tmpCert,
      CURL_CA_BUNDLE: tmpCert,
    },
  });

  async function cleanupAndExit(code: number | null) {
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      await sessionPost(meta.serverUrl, "/session/end", {
        machineId: meta.id,
        sessionId,
      }).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    if (sharerAccount) restoreClaudeJson(originalAccount);
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    console.log(`\nSession ended. Duration: ${mins}m ${secs}s`);
    process.exit(code ?? 0);
  }

  child.on("exit", (code) => {
    void cleanupAndExit(code);
  });
  child.on("error", (err) => {
    console.error("\nFailed to launch claude:", err.message);
    logger.error("Failed to launch claude process", err);
    console.error(
      "Is 'claude' installed? Run: npm install -g @anthropic-ai/claude-code",
    );
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      void sessionPost(meta.serverUrl, "/session/end", {
        machineId: meta.id,
        sessionId,
      }).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    if (sharerAccount) restoreClaudeJson(originalAccount);
    process.exit(1);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// Identify which arg indices belong to claude-receive itself
const ownIdxs = new Set<number>();
args.forEach((a, i) => {
  if (a === "--list" || a === "-l") ownIdxs.add(i);
  if (a === "--cleanup") ownIdxs.add(i);
  if (a === "--reconnect" || a === "-r") {
    ownIdxs.add(i);
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
  if (a.startsWith("--share=")) ownIdxs.add(i);
});

const claudeArgs = args.filter((_, i) => !ownIdxs.has(i));
const shareArg = args.find((a) => a.startsWith("--share="));

// Silently remove connections whose sharing window has elapsed
if (args[0] !== "--cleanup") pruneExpiredConnections();

if (args[0] === "--cleanup") {
  cleanupFlow();
} else if (args[0] === "--list" || args[0] === "-l") {
  await listFlow();
} else if (args[0] === "--reconnect" || args[0] === "-r") {
  await reconnectFlow(args[1], claudeArgs);
} else if (shareArg) {
  const connectUrl = shareArg.slice("--share=".length).trim();
  const parsed = parseConnectUrl(connectUrl);
  if (!parsed) {
    console.error(
      "Invalid --share URL. Expected: http://host:port/connect/PAIRINGCODE",
    );
    process.exit(1);
  }

  // Check if we already have credentials for this sharer
  const existing = findConnectionByServerUrl(parsed.serverUrl);
  if (existing) {
    const health = await checkHealth(existing.serverUrl);
    if (health.alive && health.sessionId === existing.sessionId) {
      // Same session still running — skip pairing entirely
      p.intro("claude-receive");
      p.log.info(`Resuming existing connection for ${existing.name}`);
      await launchClaude(
        existing.serverUrl,
        existing.caPem,
        existing,
        claudeArgs,
        existing.sharerAccount ?? null,
      );
    } else if (!health.alive) {
      p.log.error(
        "Sharer is offline or the session has expired. Ask the sharer for a new connect URL.",
      );
      process.exit(1);
    } else {
      // Sharer restarted (new sessionId) — must pair fresh
      await pairFlow(parsed, claudeArgs);
    }
  } else {
    await pairFlow(parsed, claudeArgs);
  }
} else {
  // No --share flag: check for active saved connections first
  const saved = loadConnections();

  if (saved.length > 0) {
    const spin = p.spinner();
    spin.start("Checking active sharers...");
    const results = await Promise.all(
      saved.map(async (c) => {
        const health = await checkHealth(c.serverUrl);
        return {
          conn: c,
          alive: health.alive && health.sessionId === c.sessionId,
        };
      }),
    );
    spin.stop();

    const active = results.filter((r) => r.alive).map((r) => r.conn);

    if (active.length > 0) {
      p.intro("claude-receive");
      const pick = await p.select({
        message: "Connect to an active sharer or pair with a new one:",
        options: [
          ...active.map((c) => ({
            value: c.id,
            label: c.name,
            hint: c.serverUrl,
          })),
          {
            value: "__new__",
            label: "Pair with a new sharer…",
            hint: "enter a connect URL",
          },
        ],
      });
      if (p.isCancel(pick)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (pick === "__new__") {
        await pairFlow(undefined, claudeArgs);
      } else {
        const chosen = active.find((c) => c.id === pick)!;
        await launchClaude(
          chosen.serverUrl,
          chosen.caPem,
          chosen,
          claudeArgs,
          chosen.sharerAccount ?? null,
        );
      }
    } else {
      await pairFlow(undefined, claudeArgs);
    }
  } else {
    await pairFlow(undefined, claudeArgs);
  }
}
