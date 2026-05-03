#!/usr/bin/env node
import "reflect-metadata";
import net from "node:net";
import os from "node:os";
import { serve } from "@hono/node-server";
import { render } from "ink";
import React from "react";

import { initToken, stopTokenRefresh } from "./proxy/token.js";
import { generateEphemeralCA } from "./ca/generator.js";
import {
  createSession,
  destroySession,
  isSessionExpired,
} from "./session/manager.js";
import { createMitmProxy } from "./proxy/mitm.js";
import { createPortDetector } from "./port/detector.js";
import { createApiApp } from "./server/index.js";
import { startTunnel } from "./tunnel/index.js";
import { App } from "./tui/App.js";

function getLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      // Skip loopback and non-IPv4
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

const DURATIONS = {
  session: 8 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

async function main() {
  console.log("Starting claude-share...");

  await initToken();
  console.log("Token loaded from keychain.");

  const ca = await generateEphemeralCA();
  console.log("Ephemeral CA generated.");

  const durationArg = process.argv[2];
  const duration =
    durationArg === "week"
      ? DURATIONS.week
      : durationArg === "session"
        ? DURATIONS.session
        : DURATIONS.day;

  const session = createSession(duration);

  const PORT = parseInt(process.env.PORT ?? "8080", 10);
  // Internal port for the Hono API server — not exposed externally
  const API_PORT = PORT + 1;

  let loopbackUrl = `http://localhost:${PORT}`;

  // Start Hono API server on internal port
  const apiApp = createApiApp(loopbackUrl, ca.certPem);
  const honoServer = serve({
    fetch: apiApp.fetch,
    port: API_PORT,
    hostname: "127.0.0.1",
  });

  const mitmProxy = createMitmProxy(ca);

  // Single-port detector: CONNECT → MITM proxy, HTTP → Hono API (via internal port pipe)
  const detector = createPortDetector({
    onConnect: (socket) => mitmProxy.handleSocket(socket),
    onHttp: (socket) => {
      // Pipe non-CONNECT traffic to the internal Hono server
      const upstream = net.connect(API_PORT, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
  });

  await new Promise<void>((resolve) => detector.listen(PORT, resolve));
  console.log(`Listening on port ${PORT}`);

  console.log("Starting Cloudflare tunnel...");
  let tunnel: Awaited<ReturnType<typeof startTunnel>>;
  let publicUrl: string | null = null;
  const lanIp = getLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${PORT}` : null;

  try {
    tunnel = await startTunnel(PORT);
    publicUrl = tunnel.publicUrl;
    console.log(`Tunnel active: ${publicUrl}`);
  } catch (err) {
    console.warn("Could not start tunnel", (err as Error).message);
    tunnel = { publicUrl, close: () => {} };
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
      pairingCode: session.pairingCode,
      localPort: PORT,
      sharedUntil: session.sharedUntil,
      onRevoke: () => {},
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
