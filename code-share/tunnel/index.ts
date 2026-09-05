import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { logger } from "../logger";

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === "win32";

// Bore server + secret, in priority order:
//   1. BORE_SERVER / BORE_PASSWORD in the environment at runtime
//   2. `boreServer` / `boreSecret` in ~/.code-share/config.json
//   3. defaults baked in at build time (scripts/build.ts, --define)
//   4. bore.pub with no secret
function readShareConfig(): Record<string, unknown> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".code-share", "config.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}
const _cfg = readShareConfig();
const BORE_SERVER: string =
  process.env.BORE_SERVER ||
  (typeof _cfg["boreServer"] === "string" && _cfg["boreServer"]) ||
  process.env.CODE_SHARE_BAKED_BORE_SERVER ||
  "bore.pub";
const BORE_PASSWORD: string =
  process.env.BORE_PASSWORD ||
  (typeof _cfg["boreSecret"] === "string" && _cfg["boreSecret"]) ||
  process.env.CODE_SHARE_BAKED_BORE_PASSWORD ||
  "";

// Where we install bore when it isn't already in PATH
const BORE_LOCAL_PATH = IS_WIN
  ? path.join(os.homedir(), ".code-share", "bin", "bore.exe")
  : path.join(os.homedir(), ".local", "bin", "bore");

export type TunnelState = "connected" | "reconnecting" | "down";

export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}

export interface TunnelEvents {
  /** Called on every state change; `publicUrl` is the current URL (stable across reconnects). */
  onStatus?: (state: TunnelState, publicUrl: string | null, attempt: number) => void;
}

export function boreServer(): string {
  return BORE_SERVER;
}

// Returns the bore binary path (from PATH or the known local install location),
// or null if bore is not found.
async function getBorePath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(IS_WIN ? "where" : "which", ["bore"]);
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  try {
    await fs.promises.access(BORE_LOCAL_PATH, fs.constants.X_OK);
    return BORE_LOCAL_PATH;
  } catch {}
  return null;
}

export async function isBoreInstalled(): Promise<boolean> {
  return (await getBorePath()) !== null;
}

// Follow redirects and return the final response.
function httpsGet(url: string): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const attempt = (target: string, hops = 0) => {
      if (hops > 5) return reject(new Error("Too many redirects"));
      https
        .get(target, { headers: { "User-Agent": "code-share" } }, (res) => {
          const st = res.statusCode ?? 0;
          if ((st === 301 || st === 302 || st === 307 || st === 308) && res.headers.location) {
            res.resume();
            attempt(res.headers.location, hops + 1);
          } else {
            resolve(res);
          }
        })
        .on("error", reject);
    };
    attempt(url);
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await httpsGet(url);
  return new Promise((resolve, reject) => {
    let data = "";
    res.on("data", (c: Buffer) => (data += c));
    res.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    res.on("error", reject);
  });
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await httpsGet(url);
  if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
    res.resume();
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on("finish", () => file.close(() => resolve()));
    file.on("error", reject);
  });
}

// (platform, arch) → bore release target triple + archive extension
function releaseTarget(): { triple: string; ext: "tar.gz" | "zip" } | null {
  const arch = process.arch;
  switch (process.platform) {
    case "linux": {
      const m: Record<string, string> = {
        x64: "x86_64-unknown-linux-musl",
        arm64: "aarch64-unknown-linux-musl",
        arm: "armv7-unknown-linux-musleabihf",
        ia32: "i686-unknown-linux-musl",
      };
      return m[arch] ? { triple: m[arch], ext: "tar.gz" } : null;
    }
    case "darwin": {
      const m: Record<string, string> = {
        x64: "x86_64-apple-darwin",
        arm64: "aarch64-apple-darwin",
      };
      return m[arch] ? { triple: m[arch], ext: "tar.gz" } : null;
    }
    case "win32": {
      const m: Record<string, string> = {
        x64: "x86_64-pc-windows-msvc",
        ia32: "i686-pc-windows-msvc",
        // No native arm64 build — the x64 binary runs under emulation.
        arm64: "x86_64-pc-windows-msvc",
      };
      return m[arch] ? { triple: m[arch], ext: "zip" } : null;
    }
    default:
      return null;
  }
}

async function installBoreFromGithub(): Promise<void> {
  const target = releaseTarget();
  if (!target) {
    throw new Error(
      `No pre-built bore binary for ${process.platform}/${process.arch}. ` +
        "Install bore manually: https://github.com/ekzhang/bore",
    );
  }

  const release = (await fetchJson(
    "https://api.github.com/repos/ekzhang/bore/releases/latest",
  )) as { tag_name: string };
  const tag = release.tag_name; // e.g. "v0.6.0"
  const filename = `bore-${tag}-${target.triple}.${target.ext}`;
  const downloadUrl = `https://github.com/ekzhang/bore/releases/download/${tag}/${filename}`;

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bore-install-"));
  const archivePath = path.join(tmpDir, filename);
  const binName = IS_WIN ? "bore.exe" : "bore";

  try {
    await downloadToFile(downloadUrl, archivePath);

    // Archive contains a single file named "bore"/"bore.exe" at root.
    // `tar` handles .tar.gz everywhere and .zip on Windows 10+ (bsdtar).
    await execFileAsync("tar", ["-xf", archivePath, "-C", tmpDir, binName]);

    const installDir = path.dirname(BORE_LOCAL_PATH);
    await fs.promises.mkdir(installDir, { recursive: true });
    await fs.promises.copyFile(path.join(tmpDir, binName), BORE_LOCAL_PATH);
    if (!IS_WIN) await fs.promises.chmod(BORE_LOCAL_PATH, 0o755);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function installBore(): Promise<void> {
  const spin = p.spinner();

  spin.start("Downloading bore binary from GitHub...");
  try {
    await installBoreFromGithub();
    spin.stop(`bore installed to ${BORE_LOCAL_PATH}`);
    return;
  } catch (err) {
    spin.stop(`Binary download failed: ${(err as Error).message}.`);
  }

  // Fallbacks: brew on macOS, cargo anywhere.
  const candidates: Array<[string, string[]]> = [];
  if (process.platform === "darwin") candidates.push(["brew", ["install", "bore-cli"]]);
  candidates.push(["cargo", ["install", "bore-cli"]]);

  for (const [bin, args] of candidates) {
    try {
      await execFileAsync(IS_WIN ? "where" : "which", [bin]);
    } catch {
      continue;
    }
    spin.start(`Running: ${bin} ${args.join(" ")}`);
    try {
      await execFileAsync(bin, args, { shell: IS_WIN });
      spin.stop(`bore installed via ${bin}.`);
      return;
    } catch (err) {
      spin.stop(`${bin} install failed: ${(err as Error).message}`);
    }
  }

  throw new Error("Could not install bore — install it manually: https://github.com/ekzhang/bore");
}

/**
 * Starts a bore tunnel and keeps it alive: if the bore process dies (bore.pub
 * hiccup, network blip) we reconnect and ask for the *same* remote port so the
 * public URL the receiver saved keeps working.
 */
/** True when bore rejected us because the server wants a secret we don't have. */
export function isTunnelAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /requires authentication|invalid secret|incorrect secret|no client secret/i.test(msg);
}

export async function startTunnel(
  localPort: number,
  events: TunnelEvents = {},
): Promise<Tunnel> {
  const boreBin = (await getBorePath()) ?? "bore";

  let closing = false;
  let proc: ChildProcess | null = null;
  let remotePort: number | null = null;
  let publicUrl: string | null = null;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function spawnOnce(requestPort: number | null): Promise<number> {
    const args = ["local", String(localPort), "--to", BORE_SERVER];
    if (requestPort) args.push("--port", String(requestPort));
    if (BORE_PASSWORD) args.push("--secret", BORE_PASSWORD);

    return new Promise((resolve, reject) => {
      const child = spawn(boreBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      proc = child;

      let settled = false;
      let lastError = "";
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error("bore timed out"));
        }
      }, 30_000);

      function onData(chunk: Buffer) {
        const text = chunk.toString();
        const match = text.match(/listening at \S+:(\d+)/i);
        if (match && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(parseInt(match[1], 10));
        }
        if (/error|failed|denied/i.test(text)) {
          logger.warn(`[bore] ${text.trim()}`);
          // Keep the human-readable part (bore prints "Error: <reason>").
          lastError = text.replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n").pop() ?? text.trim();
        }
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(lastError || `bore exited with code ${code}`));
        } else if (!closing && proc === child) {
          logger.warn(`[bore] tunnel process exited (code ${code}) — reconnecting`);
          scheduleReconnect();
        }
      });
    });
  }

  function scheduleReconnect() {
    if (closing || reconnectTimer) return;
    attempt += 1;
    events.onStatus?.("reconnecting", publicUrl, attempt);
    const delay = Math.min(2_000 * 2 ** Math.min(attempt - 1, 5), 60_000);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (closing) return;
      try {
        // Ask for the same port so saved connect URLs stay valid; if the
        // server refuses it (someone grabbed it), fall back to a new port.
        let port: number;
        try {
          port = await spawnOnce(remotePort);
        } catch (err) {
          if (!remotePort) throw err;
          logger.warn("[bore] could not reclaim previous port, requesting a new one", err);
          port = await spawnOnce(null);
        }
        remotePort = port;
        const url = `https://${BORE_SERVER}:${port}`;
        const changed = url !== publicUrl;
        publicUrl = url;
        attempt = 0;
        logger.info(`[bore] tunnel reconnected at ${url}${changed ? " (port changed)" : ""}`);
        events.onStatus?.("connected", publicUrl, 0);
      } catch (err) {
        logger.warn("[bore] reconnect failed", err);
        if (attempt >= 30) events.onStatus?.("down", publicUrl, attempt);
        scheduleReconnect();
      }
    }, delay);
    reconnectTimer.unref();
  }

  remotePort = await spawnOnce(null);
  publicUrl = `https://${BORE_SERVER}:${remotePort}`;
  events.onStatus?.("connected", publicUrl, 0);

  return {
    get publicUrl() {
      return publicUrl;
    },
    close() {
      closing = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      proc?.kill();
    },
  };
}
