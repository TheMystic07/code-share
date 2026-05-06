#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import https from "node:https";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { cache } from "./cache.js";
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
  systemName?: string;
  proxyUser: string;
  proxyPass: string;
}

interface SavedConnection {
  id: string;
  systemName: string;
  lanServerUrl: string | null;
  publicServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601 — used to prune expired connections on startup
  caPem: string;
  savedAt: string;
  sharerAccount: SharerAccount | null;
  proxyUser: string;
  proxyPass: string;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_SHARE_DIR = path.join(os.homedir(), ".claude-share");
const CONNECTIONS_DIR = path.join(CLAUDE_SHARE_DIR, "connections");

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

function getDeviceName(): string {
  const saved = readConfig();
  if (saved?.deviceName) return saved.deviceName;
  const name = os.hostname();
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
  const all = loadConnections().filter(
    (c) => c.lanServerUrl === serverUrl || c.publicServerUrl === serverUrl,
  );
  if (all.length === 0) return null;
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

// ── HTTPS-aware fetch helper ─────────────────────────────────────────────────
// Native fetch can't be given a custom CA cert, so we use node:https for HTTPS
// URLs (once the CA cert is known) and fall back to native fetch for HTTP.

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  signal?: AbortSignal;
  /** CA cert PEM — enables TLS verification for HTTPS requests */
  ca?: string;
  /** Skip TLS verification entirely (safe for the first /pair call since the response is E2E encrypted) */
  rejectUnauthorized?: boolean;
}

interface ApiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

async function apiFetch(
  url: string,
  opts: ApiFetchOptions = {},
): Promise<ApiFetchResponse> {
  const {
    ca,
    rejectUnauthorized = true,
    timeout = 10_000,
    signal,
    method = "GET",
    headers = {},
    body,
  } = opts;

  if (url.startsWith("https:")) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parseInt(parsed.port || "443", 10),
          path: parsed.pathname + parsed.search,
          method,
          headers,
          ca,
          rejectUnauthorized,

          // this is important: node fails to derive servername automatically when dealing with IP based URLs
          servername: parsed.hostname,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: () => Promise.resolve(JSON.parse(data)),
            });
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeout, () =>
        req.destroy(new Error("Request timed out")),
      );
      signal?.addEventListener("abort", () =>
        req.destroy(new Error("Aborted")),
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // HTTP — use native fetch
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  const res = await fetch(url, { method, headers, body, signal: fetchSignal });
  return { ok: res.ok, status: res.status, json: () => res.json() };
}

// ── Health check ─────────────────────────────────────────────────────────────

interface HealthResult {
  alive: boolean;
  sessionId: string | null;
}

async function checkHealth(
  serverUrl: string,
  caPem?: string,
  timeout = 2000,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const res = await apiFetch(`${serverUrl}/health`, {
      signal: controller.signal,
      ca: caPem,
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
  } catch (err) {
    return { alive: false, sessionId: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface ResolvedUrl {
  url: string;
  alive: boolean;
  sessionId: string | null;
}

async function resolveActiveUrl(conn: SavedConnection): Promise<ResolvedUrl> {
  const cacheKey = `resolvedUrl:${conn.id}`;
  const cached = cache.get<ResolvedUrl>(cacheKey);
  if (cached) return cached;

  const candidates: Array<{ url: string; timeout: number }> = [];

  if (conn.lanServerUrl) {
    candidates.push({ url: conn.lanServerUrl, timeout: 1000 });
  }

  if (conn.publicServerUrl) {
    candidates.push({ url: conn.publicServerUrl, timeout: 2000 });
  }

  const fallback: ResolvedUrl = {
    url: candidates[0]?.url ?? "",
    alive: false,
    sessionId: null,
  };

  if (candidates.length === 0) return fallback;

  const overallTimeout = new Promise<ResolvedUrl>((resolve) =>
    setTimeout(() => resolve(fallback), 3_000),
  );

  const race = Promise.any(
    candidates.map(async ({ url, timeout }) => {
      const h = await checkHealth(url, conn.caPem, timeout);
      if (!h.alive) throw new Error("not alive");
      return { url, alive: true as const, sessionId: h.sessionId };
    }),
  ).catch((err) => {
    return fallback;
  });

  const result = await Promise.race([race, overallTimeout]);
  if (result.alive) cache.set(cacheKey, result, 30_000);
  return result;
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

  const name = getDeviceName();
  p.log.info(`Connecting as "${name}"`);

  const spin = p.spinner();
  spin.start("Pairing...");

  let blob: string;
  let connectionId: string;
  try {
    // rejectUnauthorized: false is safe here — the /pair response is E2E encrypted
    // with the pairingCode as the key, so a MITM cannot read or forge a valid response.
    const res = await apiFetch(`${serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode.slice(0, 5), name }),
      timeout: 10_000,
      rejectUnauthorized: false,
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
    systemName: file.systemName ?? new URL(serverUrl).hostname,
    lanServerUrl: file.lanServerUrl,
    publicServerUrl: file.publicServerUrl,
    sessionId: file.sessionId,
    sharedUntil: file.sharedUntil,
    caPem: file.caPem,
    savedAt: new Date().toISOString(),
    sharerAccount: file.sharerAccount ?? null,
    proxyUser: file.proxyUser,
    proxyPass: file.proxyPass,
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
        label: `${c.systemName} — ${c.lanServerUrl ?? c.publicServerUrl ?? ""}`,
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
  spin.start(`Checking ${chosen.systemName}...`);
  const resolved = await resolveActiveUrl(chosen);
  if (!resolved.alive) {
    spin.stop("Server offline or session expired.");
    process.exit(1);
  }
  spin.stop("Server is alive.");

  await launchClaude(
    resolved.url,
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
    const { alive, url } = await resolveActiveUrl(c);
    const status = alive
      ? "\x1b[32m● online\x1b[0m"
      : "\x1b[90m○ offline\x1b[0m";
    console.log(`  ${status}  ${c.systemName}  ${url}`);
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
  caPem?: string,
): Promise<Record<string, unknown>> {
  const r = await apiFetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: 5_000,
    ca: caPem,
  });
  return r.ok ? (r.json() as Promise<Record<string, unknown>>) : {};
}

async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: {
    systemName: string;
    id: string;
    proxyUser: string;
    proxyPass: string;
  },
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
    const res = await sessionPost(
      proxyUrl,
      "/session/start",
      { machineId: meta.id },
      caPem,
    );
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
        void sessionPost(
          proxyUrl,
          "/session/heartbeat",
          {
            machineId: meta.id,
            sessionId: sessionId!,
          },
          caPem,
        ).catch(() => {});
      }, 30_000)
    : null;

  p.log.success(
    `Launching Claude via ${meta.systemName}. All API calls proxied through sharer.`,
  );

  if (claudeArgs.length > 0) p.log.info(`Extra args: ${claudeArgs.join(" ")}`);
  p.log.info("Press Ctrl+C to exit and disconnect.");
  p.outro("");

  const startTime = Date.now();

  // Proxy URL keeps https:// — the TLS terminator on the sharer routes CONNECT
  // requests to the MITM proxy after decryption, so the outer connection is
  // encrypted and proxy credentials are never sent in cleartext over the network.
  const parsedProxy = new URL(proxyUrl);
  parsedProxy.username = encodeURIComponent(meta.proxyUser);
  parsedProxy.password = encodeURIComponent(meta.proxyPass);
  const httpProxyUrl = parsedProxy.toString();

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTPS_PROXY: httpProxyUrl,
      HTTP_PROXY: httpProxyUrl,
      NODE_EXTRA_CA_CERTS: tmpCert,
      SSL_CERT_FILE: tmpCert,
      CURL_CA_BUNDLE: tmpCert,
    },
  });

  async function cleanupAndExit(code: number | null) {
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      await sessionPost(
        proxyUrl,
        "/session/end",
        {
          machineId: meta.id,
          sessionId,
        },
        caPem,
      ).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
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
      void sessionPost(
        proxyUrl,
        "/session/end",
        {
          machineId: meta.id,
          sessionId,
        },
        caPem,
      ).catch(() => {});
    }
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
  if (a === "--cleanup") ownIdxs.add(i);
  if (a === "--reconnect" || a === "-r") {
    ownIdxs.add(i);
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
  if (a.startsWith("--share=")) ownIdxs.add(i);
});

const claudeArgs = args.filter((_, i) => !ownIdxs.has(i));
const shareArg = args.find((a) => a.startsWith("--share="));

pruneExpiredConnections();

if (args[0] === "--list" || args[0] === "-l") {
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
    const resolved = await resolveActiveUrl(existing);
    if (resolved.alive && resolved.sessionId === existing.sessionId) {
      // Same session still running — skip pairing entirely
      p.intro("claude-receive");
      p.log.info(`Resuming existing connection for ${existing.systemName}`);
      await launchClaude(
        resolved.url,
        existing.caPem,
        existing,
        claudeArgs,
        existing.sharerAccount ?? null,
      );
    } else {
      // Session changed, server restarted, or TLS cert rotated (sharer restart generates
      // a new CA, so the old caPem fails verification and health returns alive=false).
      // The user provided an explicit new URL, so always attempt fresh pairing — if the
      // sharer is truly offline, pairFlow will fail with a network error naturally.
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

    const t = saved.map(async (c) => {
      return resolveActiveUrl(c).then((resolved) => ({
        conn: c,
        url: resolved.url,
        alive: resolved.alive && resolved.sessionId === c.sessionId,
      }));
    });

    const results = await Promise.all(t);

    spin.stop();

    const active = results.filter((r) => r.alive);

    if (active.length > 0) {
      p.intro("claude-receive");
      const pick = await p.select({
        message: "Connect to an active sharer or pair with a new one:",
        options: [
          ...active.map((r) => ({
            value: r.conn.id,
            label: r.conn.systemName,
            hint: r.url,
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
        const chosen = active.find((r) => r.conn.id === pick)!;
        await launchClaude(
          chosen.url,
          chosen.conn.caPem,
          chosen.conn,
          claudeArgs,
          chosen.conn.sharerAccount ?? null,
        );
      }
    } else {
      await pairFlow(undefined, claudeArgs);
    }
  } else {
    await pairFlow(undefined, claudeArgs);
  }
}
