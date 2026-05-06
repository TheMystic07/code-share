#!/usr/bin/env node
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
import { logger } from "./logger";

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
import { createMitmProxy } from "./proxy/mitm";
import { initToken, stopTokenRefresh } from "./proxy/token";
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
import { ensureBore, startTunnel } from "./tunnel/index";

const CLAUDE_SHARE_CONFIG = path.join(os.homedir(), ".claude-share", "config.json");

function hasAgreedToTerms(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8")) as Record<string, unknown>;
    return cfg["hasTermsAgreed"] === true;
  } catch {
    return false;
  }
}

function saveTermsAgreed(): void {
  const dir = path.dirname(CLAUDE_SHARE_CONFIG);
  fs.mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8")) as Record<string, unknown>;
  } catch {}
  cfg["hasTermsAgreed"] = true;
  fs.writeFileSync(CLAUDE_SHARE_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function readSharerAccount(): SharerAccount | null {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), ".claude.json"),
      "utf8",
    );
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

async function getSystemName(): Promise<string> {
  return platform().getSystemName();
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

async function promptDuration(): Promise<number> {
  const choice = await p.select({
    message: "How long do you want to share?",
    options: [
      { value: 6 * 60 * 60 * 1000, label: "6 hours" },
      { value: 24 * 60 * 60 * 1000, label: "24 hours" },
      { value: 7 * 24 * 60 * 60 * 1000, label: "1 week" },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return choice as number;
}

async function main() {
  // Check bore before any other clack prompts — p.confirm() tears down stdin
  // in a way that ink can't recover from if it runs last.
  const useTunnel =
    process.env.TUNNEL !== "0" && process.env.TUNNEL !== "false";
  const boreReady = useTunnel ? await ensureBore() : false;

  p.intro("claude-share");

  if (!hasAgreedToTerms()) {
    p.log.warn(
      "You are sharing your Anthropic subscription at your own risk.\n" +
      "This is an open-source project — you are free to try it out, but make\n" +
      "sure you trust the person you are sharing your subscription with.",
    );
    const agreed = await p.confirm({
      message: "Do you understand and want to continue?",
      initialValue: false,
    });
    if (p.isCancel(agreed) || !agreed) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    saveTermsAgreed();
  }

  await initToken();

  const duration = await promptDuration();
  const session = createSession(duration);

  const DEFAULT_PORT = 2586;
  const argv = process.argv.slice(2);
  const portIdx = argv.findIndex((a) => a === "--port" || a === "-p");
  const portEq = argv.find(
    (a) => a.startsWith("--port=") || a.startsWith("-p="),
  );
  const portFlag =
    portEq != null
      ? parseInt(portEq.split("=")[1], 10)
      : portIdx !== -1
        ? parseInt(argv[portIdx + 1], 10)
        : null;
  let PORT =
    portFlag != null && !isNaN(portFlag)
      ? portFlag
      : parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const lanIp = getLanIp();
  let lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
  let loopbackUrl = `http://localhost:${PORT}`;

  // MITM proxy resolves only after its RSA CA is ready (no race on CONNECT)
  const mitmProxy = await createMitmProxy(lanIp, (auth) => {
    const session = getSession();
    return session ? checkMachineAuth(session, auth) : false;
  });
  console.log("MITM proxy ready.");

  // Mutable — publicUrl is filled in after the tunnel starts
  const urls = { public: null as string | null, lan: lanUrl };
  const sharerAccount = readSharerAccount();
  const systemName = await getSystemName();

  // Hono API on a random localhost-only port — not exposed externally
  const apiApp = createApiApp(urls, mitmProxy.caCertPem, sharerAccount, systemName);
  const API_PORT = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
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
    { cert: mitmProxy.serverCert.certPem, key: mitmProxy.serverCert.keyPem },
    (tlsSocket) => {
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
        }
      });
    },
  );
  const TLS_TERM_PORT = await new Promise<number>((resolve, reject) => {
    tlsTermServer.once("error", reject);
    tlsTermServer.listen(0, "127.0.0.1", () => {
      resolve((tlsTermServer.address() as net.AddressInfo).port);
    });
  });

  // Single public port: TLS ClientHello → TLS terminator (handles both HTTPS API
  // and HTTPS proxy CONNECT after decryption). Plain HTTP and bare CONNECT are
  // rejected — all traffic must be wrapped in TLS.
  const detector = createPortDetector({
    onConnect: (socket) => {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    },
    onTls: (socket) => {
      const upstream = net.connect(TLS_TERM_PORT, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
    onHttp: (socket) => {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    },
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
      PORT = await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, () => {
          const port = (srv.address() as net.AddressInfo).port;
          srv.close(() => resolve(port));
        });
      });
      lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
      loopbackUrl = `http://localhost:${PORT}`;
      urls.lan = lanUrl;
      p.log.info(`Using port ${PORT} instead.`);
    } else {
      const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${PORT}`]).catch(() => ({ stdout: "" }));
      const pids = stdout.trim().split("\n").filter(Boolean);
      if (pids.length === 0) {
        p.log.error(`Could not find process on port ${PORT}.`);
        process.exit(1);
      }
      await execFileAsync("kill", ["-9", ...pids]);
      p.log.info(`Killed process on port ${PORT}, retrying…`);
    }

    await new Promise<void>((resolve, reject) => {
      detector.once("error", reject);
      detector.listen(PORT, resolve);
    });
  });
  console.log(`Listening on port ${PORT}`);

  let tunnel: Awaited<ReturnType<typeof startTunnel>>;
  let publicUrl: string | null = null;
  let tunnelDown = false;
  let tunnelStartedAt: Date | null = null;
  let rerenderApp: ((node: React.ReactElement) => void) | null = null;

  if (boreReady) {
    console.log("Starting bore tunnel...");
    try {
      tunnel = await startTunnel(PORT, () => {
        tunnelDown = true;
        logger.error("bore tunnel disconnected unexpectedly");
        rerenderApp?.(makeAppElement());
      });
      publicUrl = tunnel.publicUrl;
      urls.public = publicUrl;
      if (publicUrl) {
        tunnelStartedAt = new Date();
        logger.info(`Tunnel active: ${publicUrl}`);
        console.log(`Tunnel active: ${publicUrl}`);
      } else {
        console.warn("Unable to generate public URL");
        logger.warn("bore did not return a port");
      }
    } catch (err) {
      console.warn("Unable to generate public URL:", (err as Error).message);
      logger.warn("Could not start bore tunnel", err);
      tunnel = { publicUrl: null, close: () => {} };
    }
  } else {
    tunnel = { publicUrl: null, close: () => {} };
  }

  function cleanup() {
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
      publicUrl,
      loopbackUrl,
      lanUrl,
      localPort: PORT,
      sharedUntil: session.sharedUntil,
      getSession: () => getSession(),
      tunnelDown,
      tunnelStartedAt,
      onExit: () => {
        cleanup();
        process.exit(0);
      },
    });
  }

  const { unmount, rerender } = render(makeAppElement());
  rerenderApp = rerender;

  process.on("SIGINT", () => {
    unmount();
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    unmount();
    cleanup();
    process.exit(0);
  });

  const expiryCheck = setInterval(() => {
    if (isSessionExpired(session)) {
      clearInterval(expiryCheck);
      unmount();
      cleanup();
      process.exit(0);
    }
  }, 60_000);
  expiryCheck.unref();
}

main().catch((err) => {
  logger.error("Fatal error in main", err);
  process.exit(1);
});
