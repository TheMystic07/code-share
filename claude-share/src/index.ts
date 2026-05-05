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

import { logger } from "./logger.js";
import { createPortDetector } from "./port/detector.js";
import { createMitmProxy } from "./proxy/mitm.js";
import { initToken, stopTokenRefresh } from "./proxy/token.js";
import { createApiApp } from "./server/index.js";
import {
  createSession,
  destroySession,
  isSessionExpired,
  getSession,
  regeneratePairingCode,
  type SharerAccount,
  type Machine,
} from "./session/manager.js";
import { App } from "./tui/App.js";
import { ensureBore, startTunnel } from "./tunnel/index.js";

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
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("scutil", ["--get", "ComputerName"]);
      return stdout.trim();
    }
    const { stdout } = await execFileAsync("hostname");
    return stdout.trim();
  } catch {
    return os.hostname();
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
  const PORT =
    portFlag != null && !isNaN(portFlag)
      ? portFlag
      : parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  // Internal port for the Hono API server — not exposed externally
  const API_PORT = PORT + 1;

  const lanIp = getLanIp();
  const lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
  const loopbackUrl = `http://localhost:${PORT}`;

  // MITM proxy resolves only after its RSA CA is ready (no race on CONNECT)
  const mitmProxy = await createMitmProxy(lanIp);
  console.log("MITM proxy ready.");

  // Mutable — publicUrl is filled in after the tunnel starts
  const urls = { public: null as string | null, lan: lanUrl };
  const sharerAccount = readSharerAccount();
  const systemName = await getSystemName();

  // Hono API on a localhost-only port; port detector pipes plain HTTP to it
  const apiApp = createApiApp(urls, mitmProxy.caCertPem, sharerAccount, systemName);
  const honoServer = serve({
    fetch: apiApp.fetch,
    port: API_PORT,
    hostname: "127.0.0.1",
  });

  // Internal TLS termination server: accepts raw TLS bytes from the detector,
  // does the handshake, then forwards plaintext HTTP to the Hono API port.
  // Using tls.createServer (full server lifecycle) instead of tls.TLSSocket
  // wrapping, which is not reliably supported in Bun.
  const tlsTermServer = tls.createServer(
    { cert: mitmProxy.serverCert.certPem, key: mitmProxy.serverCert.keyPem },
    (tlsSocket) => {
      const upstream = net.connect(API_PORT, "127.0.0.1");
      tlsSocket.pipe(upstream);
      upstream.pipe(tlsSocket);
      tlsSocket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          console.error("[tls] terminator error:", err.message);
        }
        upstream.destroy();
      });
      upstream.on("error", () => tlsSocket.destroy());
    },
  );
  const TLS_TERM_PORT = await new Promise<number>((resolve, reject) => {
    tlsTermServer.once("error", reject);
    tlsTermServer.listen(0, "127.0.0.1", () => {
      resolve((tlsTermServer.address() as net.AddressInfo).port);
    });
  });

  // Single public port: CONNECT → MITM proxy, TLS ClientHello → TLS terminator, plain HTTP → Hono API
  const detector = createPortDetector({
    onConnect: (socket) => mitmProxy.handleSocket(socket),
    onTls: (socket) => {
      const upstream = net.connect(TLS_TERM_PORT, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
    onHttp: (socket) => {
      const upstream = net.connect(API_PORT, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
  });

  await new Promise<void>((resolve) => detector.listen(PORT, resolve));
  console.log(`Listening on port ${PORT}`);

  let tunnel: Awaited<ReturnType<typeof startTunnel>>;
  let publicUrl: string | null = null;
  let tunnelDown = false;
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
  console.error("Fatal:", err);
  process.exit(1);
});
