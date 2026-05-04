#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

// ── Types shared with claude-share ──────────────────────────────────────────

interface ConnectionFile {
  publicServerUrl: string | null;
  lanServerUrl: string | null;
  sessionId: string;
  caPem: string;
}

interface SavedConnection {
  id: string;
  name: string;
  serverUrl: string;
  sessionId: string;
  caPem: string;
  savedAt: string;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const CONNECTIONS_DIR = path.join(os.homedir(), ".claude-share", "connections");

function ensureConnectionsDir() {
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true });
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

// ── Base58 decode ────────────────────────────────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

function parseConnectUrl(url: string): { serverUrl: string; pairingCode: string } | null {
  const match = url.match(/^(https?:\/\/.+?)\/connect\/([A-Za-z0-9]+)$/);
  if (!match) return null;
  return { serverUrl: match[1], pairingCode: match[2] };
}

// ── Health check ─────────────────────────────────────────────────────────────

async function checkHealth(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok: boolean; sessionActive: boolean };
    return body.ok && body.sessionActive;
  } catch {
    return false;
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

  const name = await p.text({
    message: "Your name (shown to sharer):",
    defaultValue: os.userInfo().username,
  });
  if (p.isCancel(name)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

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
      const err = (await res.json()) as { error: string };
      spin.stop("Failed.");
      p.log.error(err.error ?? "Pairing rejected");
      process.exit(1);
    }
    const data = (await res.json()) as { blob: string; connectionId: string };
    blob = data.blob;
    connectionId = data.connectionId;
  } catch (err) {
    spin.stop("Network error.");
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
    caPem: file.caPem,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(connectionPath(connectionId), JSON.stringify(saved, null, 2));

  await launchClaude(serverUrl, file.caPem, saved, claudeArgs);
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
  const alive = await checkHealth(chosen.serverUrl);
  if (!alive) {
    spin.stop("Server offline or session expired.");
    process.exit(1);
  }
  spin.stop("Server is alive.");

  await launchClaude(chosen.serverUrl, chosen.caPem, chosen, claudeArgs);
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
    const alive = await checkHealth(c.serverUrl);
    const status = alive ? "\x1b[32m● online\x1b[0m" : "\x1b[90m○ offline\x1b[0m";
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
    p.log.info("Onboarding not completed — marking it done so Claude launches directly.");
    config["hasCompletedOnboarding"] = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
}

async function ensureCredentials() {
  if (process.platform !== "linux") return;

  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (fs.existsSync(credPath)) return;

  p.log.warn("No ~/.claude/.credentials.json found. Claude needs this to think you're logged in.");

  const confirm = await p.confirm({
    message: "Create a placeholder credentials file so Claude launches without a login prompt?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.log.warn("Skipping credentials setup. Claude may redirect you to login.");
    return;
  }

  const placeholder = {
    claudeAiOauth: {
      accessToken: "claude-relay",
      refreshToken: "",
      // Far-future expiry — the real token is injected by the proxy, this just needs to exist
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

  fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(placeholder, null, 2), { mode: 0o600 });
  p.log.success("Created ~/.claude/.credentials.json with placeholder credentials.");
}

async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: { name: string },
  claudeArgs: string[] = [],
) {
  ensureOnboarding();
  await ensureCredentials();

  const tmpCert = path.join(os.tmpdir(), `claude-share-ca-${Date.now()}.pem`);
  fs.writeFileSync(tmpCert, caPem, { mode: 0o600 });

  p.log.success(`Launching Claude as ${meta.name}. All API calls proxied through sharer.`);
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
    },
  });

  function cleanupAndExit(code: number | null) {
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    console.log(`\nSession ended. Duration: ${mins}m ${secs}s`);
    process.exit(code ?? 0);
  }

  child.on("exit", (code) => cleanupAndExit(code));
  child.on("error", (err) => {
    console.error("\nFailed to launch claude:", err.message);
    console.error("Is 'claude' installed? Run: npm install -g @anthropic-ai/claude-code");
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
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
  if (a === "--reconnect" || a === "-r") {
    ownIdxs.add(i);
    // next arg is the optional UUID, not a claude flag
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
  if (a.startsWith("--share=")) ownIdxs.add(i);
});

// Everything else is forwarded to the claude process
const claudeArgs = args.filter((_, i) => !ownIdxs.has(i));

const shareArg = args.find((a) => a.startsWith("--share="));

if (args[0] === "--list" || args[0] === "-l") {
  await listFlow();
} else if (args[0] === "--reconnect" || args[0] === "-r") {
  await reconnectFlow(args[1], claudeArgs);
} else if (shareArg) {
  const connectUrl = shareArg.slice("--share=".length).trim();
  const parsed = parseConnectUrl(connectUrl);
  if (!parsed) {
    console.error("Invalid --share URL. Expected: http://host:port/connect/PAIRINGCODE");
    process.exit(1);
  }
  await pairFlow(parsed, claudeArgs);
} else {
  await pairFlow(undefined, claudeArgs);
}
