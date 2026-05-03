#!/usr/bin/env node
import "reflect-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import * as p from "@clack/prompts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

// ── Types shared with claude-share ──────────────────────────────────────────

interface ConnectionFile {
  serverUrl: string;
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
        return JSON.parse(fs.readFileSync(path.join(CONNECTIONS_DIR, f), "utf8")) as SavedConnection;
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
  // Derive 32-byte key: pad/truncate base58-decoded pairing code to 32 bytes
  const codeBytes = fromBase58(pairingCode);
  const key = new Uint8Array(32);
  key.set(codeBytes.slice(0, 32));

  const nonceHex = blob.slice(0, 48);
  const ctHex = blob.slice(48);
  const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
  const ciphertext = Uint8Array.from(Buffer.from(ctHex, "hex"));

  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionFile;
}

// ── Health check ─────────────────────────────────────────────────────────────

async function checkHealth(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json() as { ok: boolean; sessionActive: boolean };
    return body.ok && body.sessionActive;
  } catch {
    return false;
  }
}

// ── Pair flow ────────────────────────────────────────────────────────────────

async function pairFlow() {
  p.intro("claude-receive — pair with a new sharer");

  const serverUrl = await p.text({
    message: "Sharer URL (from their terminal):",
    placeholder: "https://xxxx.trycloudflare.com",
    validate: (v) => (v?.startsWith("http") ? undefined : "Must be a URL"),
  });
  if (p.isCancel(serverUrl)) { p.cancel("Cancelled."); process.exit(0); }

  const pairingCode = await p.text({
    message: "Pairing code (from their terminal):",
    validate: (v) => ((v?.trim().length ?? 0) > 0 ? undefined : "Required"),
  });
  if (p.isCancel(pairingCode)) { p.cancel("Cancelled."); process.exit(0); }

  const name = await p.text({
    message: "Your name (shown to sharer):",
    defaultValue: os.userInfo().username,
  });
  if (p.isCancel(name)) { p.cancel("Cancelled."); process.exit(0); }

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
      const err = await res.json() as { error: string };
      spin.stop("Failed.");
      p.log.error(err.error ?? "Pairing rejected");
      process.exit(1);
    }
    const data = await res.json() as { blob: string; connectionId: string };
    blob = data.blob;
    connectionId = data.connectionId;
  } catch (err) {
    spin.stop("Network error.");
    p.log.error((err as Error).message);
    process.exit(1);
  }

  let file: ConnectionFile;
  try {
    file = decryptBlob(blob, pairingCode as string);
  } catch {
    spin.stop("Decryption failed.");
    p.log.error("Wrong pairing code or corrupted response.");
    process.exit(1);
  }

  spin.stop("Paired successfully.");

  // Save connection for reconnect
  ensureConnectionsDir();
  const saved: SavedConnection = {
    id: connectionId,
    name: name as string,
    serverUrl: serverUrl as string,
    sessionId: file.sessionId,
    caPem: file.caPem,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(connectionPath(connectionId), JSON.stringify(saved, null, 2));

  launchClaude(file, saved);
}

// ── Reconnect flow ────────────────────────────────────────────────────────────

async function reconnectFlow(uuid?: string) {
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
    // Interactive picker
    p.intro("claude-receive — reconnect");
    const pick = await p.select({
      message: "Choose a connection:",
      options: connections.map((c) => ({
        value: c.id,
        label: `${c.name} — ${c.serverUrl}`,
        hint: `saved ${new Date(c.savedAt).toLocaleDateString()}`,
      })),
    });
    if (p.isCancel(pick)) { p.cancel("Cancelled."); process.exit(0); }
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

  launchClaude(chosen, chosen);
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

function launchClaude(file: Pick<ConnectionFile, "serverUrl" | "caPem">, meta: { name: string }) {
  // Write CA cert to a temp file
  const tmpCert = path.join(os.tmpdir(), `claude-share-ca-${Date.now()}.pem`);
  fs.writeFileSync(tmpCert, file.caPem, { mode: 0o600 });

  p.log.success(`Launching Claude as ${meta.name}. All API calls proxied through sharer.`);
  p.log.info("Press Ctrl+C to exit and disconnect.");
  p.outro("");

  const startTime = Date.now();

  const child = spawn("claude", [], {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTPS_PROXY: file.serverUrl,
      HTTP_PROXY: file.serverUrl,
      NODE_EXTRA_CA_CERTS: tmpCert,
      ANTHROPIC_API_KEY: "claude-share-dummy-key",
    },
  });

  function cleanupAndExit(code: number | null) {
    // Remove temp cert
    try { fs.unlinkSync(tmpCert); } catch {}

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
    try { fs.unlinkSync(tmpCert); } catch {}
    process.exit(1);
  });

  // Forward signals to child
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "--list" || args[0] === "-l") {
  await listFlow();
} else if (args[0] === "--reconnect" || args[0] === "-r") {
  await reconnectFlow(args[1]);
} else {
  await pairFlow();
}
