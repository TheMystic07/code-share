#!/usr/bin/env node
import "@shared/patch-console";
import "@shared/paths";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import * as p from "@clack/prompts";
import { serve } from "@hono/node-server";
import { render } from "ink";
import React from "react";

import { platform } from "@shared/platforms";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
import { logger } from "./logger";
import pkg from "../package.json";

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  process.exit(1);
});

// Exits with a clear error if the platform is unsupported
platform();

import { createPortDetector } from "./port/detector";
import { createMitmProxy, tuneSocket } from "./proxy/mitm";
import {
  getRateLimitTier,
  getSubscriptionType,
  getTokenStatus,
  stopTokenRefresh,
  subscribeTokenStatus,
  type TokenStatus,
} from "./proxy/token";
import { createApiApp } from "./server/index";
import {
  createSession,
  destroySession,
  isSessionExpired,
  getSession,
  checkMachineAuth,
  type SharerAccount,
} from "./session/manager";
import { App } from "./tui/App";
import {
  boreServer,
  isBoreInstalled,
  installBore,
  startTunnel,
  type Tunnel,
  type TunnelState,
} from "./tunnel/index";
import { verifyTokenOrExit } from "./proxy/verifyToken";

const IS_WIN = process.platform === "win32";

const CLAUDE_SHARE_CONFIG = path.join(os.homedir(), ".code-share", "config.json");

function readShareConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function patchShareConfig(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CLAUDE_SHARE_CONFIG), { recursive: true });
  fs.writeFileSync(
    CLAUDE_SHARE_CONFIG,
    JSON.stringify({ ...readShareConfig(), ...patch }, null, 2),
    { mode: 0o600 },
  );
}

function hasAgreedToTerms(): boolean {
  return readShareConfig()["hasShareTermsAgreed"] === true;
}

function readSharerAccount(): SharerAccount | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const acct = config["oauthAccount"] as Record<string, string> | undefined;
    if (!acct) return null;
    return {
      emailAddress: acct["emailAddress"] ?? "",
      displayName: acct["displayName"] ?? "",
      organizationName: acct["organizationName"] ?? "",
    };
  } catch {
    return null;
  }
}

function getLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

async function detectPublicIp(): Promise<string | null> {
  const sources = ["https://api.ipify.org", "https://checkip.amazonaws.com", "https://icanhazip.com"];
  for (const url of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      const ip = (await res.text()).trim();
      if (net.isIP(ip)) return ip;
    } catch {}
  }
  return null;
}

// ── CLI flags ─────────────────────────────────────────────────────────────────

function flagValue(argv: string[], ...names: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    for (const n of names) {
      if (a === n && argv[i + 1] && !argv[i + 1]!.startsWith("-")) return argv[i + 1]!;
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return null;
}

async function promptDuration(): Promise<number> {
  const choice = await p.select({
    message: "How long do you want to share?",
    options: [
      { value: 6 * 60 * 60 * 1000, label: "6 hours" },
      { value: 24 * 60 * 60 * 1000, label: "24 hours" },
      { value: 7 * 24 * 60 * 60 * 1000, label: "1 week" },
      { value: 30 * 24 * 60 * 60 * 1000, label: "30 days" },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return choice as number;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function killPortOwner(port: number): Promise<boolean> {
  try {
    if (IS_WIN) {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"]);
      const pids = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === "TCP" && cols[1]?.endsWith(`:${port}`) && cols[3] === "LISTENING" && cols[4]) {
          pids.add(cols[4]);
        }
      }
      if (pids.size === 0) return false;
      for (const pid of pids) await execFileAsync("taskkill", ["/PID", pid, "/F"]);
      return true;
    }
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).catch(
      () => ({ stdout: "" }),
    );
    const pids = stdout.trim().split("\n").filter(Boolean);
    if (pids.length === 0) return false;
    await execFileAsync("kill", ["-9", ...pids]);
    return true;
  } catch (err) {
    logger.warn("killPortOwner failed", err);
    return false;
  }
}

type ShareMode = "internet" | "direct" | "lan";

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--upgrade")) {
    await forceUpgrade();
    return;
  }

  await checkForUpdate();

  p.intro(`code-share v${pkg.version}`);

  if (!hasAgreedToTerms()) {
    p.log.warn(
      "Heads up: You're sharing your Claude Code at your own risk.\n" +
        "This is an open-source project and we are not liable for any damage or\n" +
        "suspension of your Claude Code subscription. Make sure you trust the\n" +
        "person you are sharing your subscription with.\n\n" +
        "This CLI is built to share your Claude Code with a few friends in need.\n" +
        "Sharing it with a lot of people can be a direct recipe for an account ban.\n" +
        "We love Claude Code and the purpose of this CLI is to help your friends\n" +
        "sometimes when they've hit their limit or just want to try it out.",
    );
    const agreed = await p.confirm({
      message: "Do you understand and want to continue?",
      initialValue: false,
    });
    if (p.isCancel(agreed) || !agreed) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    patchShareConfig({ hasShareTermsAgreed: true });
  }

  // ── Share mode ───────────────────────────────────────────────────────────────
  const envTunnel = process.env.TUNNEL !== "0" && process.env.TUNNEL !== "false";
  const publicHostFlag = flagValue(argv, "--public-host") ?? process.env.PUBLIC_HOST ?? null;
  const modeFlag = (flagValue(argv, "--mode") ??
    (argv.includes("--direct") ? "direct" : argv.includes("--lan") ? "lan" : null)) as
    | ShareMode
    | null;

  let shareMode: ShareMode;
  if (!envTunnel) {
    shareMode = "lan";
    p.log.info("TUNNEL=0 — sharing on LAN only.");
  } else if (modeFlag) {
    shareMode = modeFlag;
  } else if (publicHostFlag) {
    shareMode = "direct";
  } else {
    const lastMode = readShareConfig()["lastShareMode"] as ShareMode | undefined;
    const options = [
      {
        value: "internet" as const,
        label: "Internet via tunnel",
        hint: `bore tunnel through ${boreServer()} — works behind NAT, can be flaky`,
      },
      {
        value: "direct" as const,
        label: "Internet direct",
        hint: "this machine has a public IP / port-forward — most reliable",
      },
      {
        value: "lan" as const,
        label: "LAN only",
        hint: "both machines on the same network",
      },
    ];
    const choice = await p.select({
      message: "How do you want to share?",
      options,
      initialValue: lastMode ?? "internet",
    });
    if (p.isCancel(choice)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    shareMode = choice;
    patchShareConfig({ lastShareMode: shareMode });
  }

  let boreReady = false;
  if (shareMode === "internet") {
    if (await isBoreInstalled()) {
      boreReady = true;
    } else {
      try {
        await installBore();
        boreReady = true;
      } catch (err) {
        p.log.warn(`Could not install bore (${(err as Error).message}) — sharing on LAN only.`);
      }
    }
  }

  await verifyTokenOrExit();

  const duration = await promptDuration();
  const session = createSession(duration);

  const DEFAULT_PORT = 2586;
  const portFlag = flagValue(argv, "--port", "-p");
  let PORT =
    portFlag != null && !isNaN(parseInt(portFlag, 10))
      ? parseInt(portFlag, 10)
      : parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const lanIp = getLanIp();

  // ── Direct mode: figure out how the outside world reaches us ────────────────
  let directHost: string | null = null; // host[:port] receivers should use
  let publicIp: string | null = null;
  if (shareMode === "direct") {
    if (publicHostFlag) {
      directHost = publicHostFlag;
    } else {
      const spin = p.spinner();
      spin.start("Detecting public IP…");
      publicIp = await detectPublicIp();
      spin.stop(publicIp ? `Public IP: ${publicIp}` : "Could not detect public IP.");
      const entered = await p.text({
        message: "Public host (and port if different) receivers should connect to:",
        placeholder: publicIp ? `${publicIp}:${PORT}` : "my.server.example.com:2586",
        initialValue: publicIp ? `${publicIp}:${PORT}` : "",
        validate: (v) => (v?.trim() ? undefined : "Required"),
      });
      if (p.isCancel(entered)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      directHost = (entered as string).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    }
    p.log.info(
      `Make sure TCP port ${PORT} on this machine is reachable from the internet\n` +
        `(firewall / router port-forward → ${directHost}).`,
    );
  }

  const directHostname = directHost ? directHost.split(":")[0]! : null;
  const certHosts = {
    hostnames: [boreServer(), directHostname].filter((h): h is string => !!h),
    ips: [lanIp, publicIp].filter((h): h is string => !!h),
  };

  // MITM proxy resolves only after its RSA CA is ready (no race on CONNECT)
  const mitmProxy = await createMitmProxy(certHosts, (auth) => {
    const session = getSession();
    return session ? checkMachineAuth(session, auth) : false;
  });
  logger.info("MITM proxy ready");

  // Mutable — publicUrl is filled in after the tunnel starts / from direct host
  const urls = { public: null as string | null, lan: lanIp ? `https://${lanIp}:${PORT}` : null };
  let loopbackUrl = `http://localhost:${PORT}`;
  const sharerAccount = readSharerAccount();
  const systemName = await platform().getSystemName();

  // Hono API on a random localhost-only port — not exposed externally
  const apiApp = createApiApp(urls, mitmProxy.caCertPem, sharerAccount, systemName, () => ({
    subscriptionType: getSubscriptionType(),
    rateLimitTier: getRateLimitTier(),
  }));
  const API_PORT = await freePort();
  const honoServer = serve({
    fetch: apiApp.fetch,
    port: API_PORT,
    hostname: "127.0.0.1",
  });

  // Internal TLS termination server: accepts raw TLS bytes from the detector,
  // does the handshake, then routes by sniffing the first decrypted bytes:
  //   CONNECT → MITM proxy (HTTPS proxy tunnel)
  //   anything else → Hono API port (regular HTTPS API call)
  const tlsTermServer = tls.createServer(
    {
      cert: mitmProxy.serverCert.certPem,
      key: mitmProxy.serverCert.keyPem,
      handshakeTimeout: 20_000,
    },
    (tlsSocket) => {
      tuneSocket(tlsSocket);
      tlsSocket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          logger.error("[tls] socket error", err);
        }
      });

      tlsSocket.once("data", (chunk) => {
        const isConnect = chunk.slice(0, 8).toString("ascii").toUpperCase().startsWith("CONNECT");
        tlsSocket.unshift(chunk);
        if (isConnect) {
          mitmProxy.handleSocket(tlsSocket);
        } else {
          const upstream = net.connect(API_PORT, "127.0.0.1");
          tlsSocket.pipe(upstream);
          upstream.pipe(tlsSocket);
          upstream.on("error", () => tlsSocket.destroy());
          tlsSocket.on("close", () => upstream.destroy());
        }
      });
    },
  );
  tlsTermServer.on("tlsClientError", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ECONNRESET" && code !== "ERR_TLS_HANDSHAKE_TIMEOUT") {
      logger.warn("[tls] client error", err);
    }
  });
  const TLS_TERM_PORT = await new Promise<number>((resolve, reject) => {
    tlsTermServer.once("error", reject);
    tlsTermServer.listen(0, "127.0.0.1", () => {
      resolve((tlsTermServer.address() as net.AddressInfo).port);
    });
  });

  // Single public port: TLS ClientHello → TLS terminator (handles both HTTPS API
  // and HTTPS proxy CONNECT after decryption). Plain HTTP and bare CONNECT are
  // rejected — all traffic must be wrapped in TLS.
  const reject426 = (socket: net.Socket) => {
    socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  };
  const detector = createPortDetector({
    onConnect: reject426,
    onTls: (socket) => {
      tuneSocket(socket);
      const upstream = net.connect(TLS_TERM_PORT, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    },
    onHttp: reject426,
  });

  await new Promise<void>((resolve, reject) => {
    detector.once("error", reject);
    detector.listen(PORT, resolve);
  }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;

    const kill = await p.confirm({
      message: `Port ${PORT} is already in use. Kill the process and continue?`,
    });
    if (p.isCancel(kill)) {
      p.cancel("Cancelled.");
      process.exit(1);
    }

    if (!kill) {
      PORT = await freePort();
      urls.lan = lanIp ? `https://${lanIp}:${PORT}` : null;
      loopbackUrl = `http://localhost:${PORT}`;
      p.log.info(`Using port ${PORT} instead.`);
    } else {
      if (!(await killPortOwner(PORT))) {
        p.log.error(`Could not find/kill the process on port ${PORT}.`);
        process.exit(1);
      }
      p.log.info(`Killed process on port ${PORT}, retrying…`);
      await new Promise((r) => setTimeout(r, 500));
    }

    await new Promise<void>((resolve, reject) => {
      detector.once("error", reject);
      detector.listen(PORT, resolve);
    });
  });
  logger.info(`Listening on port ${PORT}`);

  // ── Public reachability ──────────────────────────────────────────────────────
  let tunnel: Tunnel = { publicUrl: null, close: () => {} };
  let tunnelState: TunnelState | null = null;
  let tunnelAttempt = 0;
  let tunnelStartedAt: Date | null = null;
  let rerenderApp: ((node: React.ReactElement) => void) | null = null;

  if (shareMode === "direct" && directHost) {
    const hostPort = directHost.includes(":") ? directHost : `${directHost}:${PORT}`;
    urls.public = `https://${hostPort}`;
    logger.info(`Direct mode: public URL ${urls.public}`);
  } else if (boreReady) {
    logger.info("Starting bore tunnel");
    const spin = p.spinner();
    spin.start("Starting tunnel…");
    try {
      tunnel = await startTunnel(PORT, {
        onStatus: (state, publicUrl, attempt) => {
          tunnelState = state;
          tunnelAttempt = attempt;
          if (publicUrl) urls.public = publicUrl;
          if (state === "connected" && !tunnelStartedAt) tunnelStartedAt = new Date();
          rerenderApp?.(makeAppElement());
        },
      });
      urls.public = tunnel.publicUrl;
      tunnelStartedAt = new Date();
      spin.stop(urls.public ? `Tunnel active: ${urls.public}` : "Tunnel started but returned no port");
      logger.info(`Tunnel active: ${urls.public}`);
    } catch (err) {
      spin.stop("Could not start tunnel — sharing on LAN only.");
      logger.warn("Could not start bore tunnel", err);
    }
  }

  // ── TUI ──────────────────────────────────────────────────────────────────────
  let tokenStatus: TokenStatus = getTokenStatus();
  const unsubToken = subscribeTokenStatus((s) => {
    tokenStatus = s;
    rerenderApp?.(makeAppElement());
  });

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    unsubToken();
    mitmProxy.close();
    tunnel.close();
    detector.close();
    tlsTermServer.close();
    (honoServer as any).close?.();
    stopTokenRefresh();
    destroySession();
  }

  function makeAppElement(): React.ReactElement {
    return React.createElement(App, {
      publicUrl: urls.public,
      loopbackUrl,
      lanUrl: urls.lan,
      localPort: PORT,
      sharedUntil: session.sharedUntil,
      getSession: () => getSession(),
      tunnelState,
      tunnelAttempt,
      tunnelStartedAt,
      tokenStatus,
      onExit: () => {
        cleanup();
        process.exit(0);
      },
    });
  }

  const { unmount, rerender } = render(makeAppElement());
  rerenderApp = rerender;

  const shutdown = () => {
    unmount();
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (IS_WIN) process.on("SIGBREAK", shutdown);

  const expiryCheck = setInterval(() => {
    if (isSessionExpired(session)) {
      clearInterval(expiryCheck);
      shutdown();
    }
  }, 60_000);
  expiryCheck.unref();
}

main().catch((err) => {
  logger.error("Fatal error in main", err);
  p.log.error(`Fatal: ${(err as Error).message ?? err}`);
  process.exit(1);
});
