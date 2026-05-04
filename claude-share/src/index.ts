#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import { serve } from "@hono/node-server";
import { render } from "ink";
import React from "react";

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
import { startTunnel } from "./tunnel/index.js";

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
  p.intro("claude-share");

  await initToken();

  const duration = await promptDuration();
  const session = createSession(duration);

  const DEFAULT_PORT = 47821;
  const argv = process.argv.slice(2);
  const portIdx = argv.findIndex((a) => a === "--port" || a === "-p");
  const portEq = argv.find((a) => a.startsWith("--port=") || a.startsWith("-p="));
  const portFlag =
    portEq != null ? parseInt(portEq.split("=")[1], 10)
    : portIdx !== -1 ? parseInt(argv[portIdx + 1], 10)
    : null;
  const PORT = (portFlag != null && !isNaN(portFlag))
    ? portFlag
    : parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  // Internal port for the Hono API server — not exposed externally
  const API_PORT = PORT + 1;

  const lanIp = getLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${PORT}` : null;
  const loopbackUrl = `http://localhost:${PORT}`;

  // MITM proxy resolves only after its RSA CA is ready (no race on CONNECT)
  const mitmProxy = await createMitmProxy();
  console.log("MITM proxy ready.");

  // Mutable — publicUrl is filled in after the tunnel starts
  const urls = { public: null as string | null, lan: lanUrl };
  const sharerAccount = readSharerAccount();

  // Hono API on a localhost-only port; port detector pipes plain HTTP to it
  const apiApp = createApiApp(urls, mitmProxy.caCertPem, sharerAccount);
  const honoServer = serve({
    fetch: apiApp.fetch,
    port: API_PORT,
    hostname: "127.0.0.1",
  });

  // Single public port: CONNECT → MITM proxy, plain HTTP → Hono API
  const detector = createPortDetector({
    onConnect: (socket) => mitmProxy.handleSocket(socket),
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

  const useTunnel = process.env.TUNNEL !== "0" && process.env.TUNNEL !== "false";

  if (useTunnel) {
    console.log("Starting Cloudflare tunnel...");
    try {
      tunnel = await startTunnel(PORT);
      publicUrl = tunnel.publicUrl;
      urls.public = publicUrl;
      console.log(`Tunnel active: ${publicUrl}`);
    } catch (err) {
      console.warn("Could not start tunnel", (err as Error).message);
      tunnel = { publicUrl: null, close: () => {} };
    }
  } else {
    tunnel = { publicUrl: null, close: () => {} };
  }

  function cleanup() {
    mitmProxy.close();
    tunnel.close();
    detector.close();
    (honoServer as any).close?.();
    stopTokenRefresh();
    destroySession();
  }

  const { unmount } = render(
    React.createElement(App, {
      publicUrl,
      loopbackUrl,
      lanUrl,
      localPort: PORT,
      sharedUntil: session.sharedUntil,
      getSession: () => getSession(),
      onExit: () => {
        cleanup();
        process.exit(0);
      },
    }),
  );

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
