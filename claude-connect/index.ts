#!/usr/bin/env node
import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { pairFlow } from "./flows/pair";
import { reconnectFlow } from "./flows/reconnect";
import { listFlow } from "./flows/list";
import { resolveActiveUrl } from "./health";
import { launchClaude } from "./launch";
import { logger } from "./logger";
import { parseConnectUrl } from "./pairing";
import {
  findConnectionByServerUrl,
  hasAgreedToTerms,
  loadConnections,
  pruneExpiredConnections,
  saveTermsAgreed,
} from "./storage";

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

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// Identify which arg indices belong to claude-connect itself
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

if (!hasAgreedToTerms()) {
  p.intro("claude-connect");
  p.log.warn(
    "You are connecting to someone else's Anthropic subscription at your own risk.\n" +
    "This is an open-source project — you are free to try it out, but make\n" +
    "sure you trust the person sharing their subscription with you.",
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

// ── Dispatch ──────────────────────────────────────────────────────────────────

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
      p.intro("claude-connect");
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

    const results = await Promise.all(
      saved.map(async (c) => {
        const resolved = await resolveActiveUrl(c);
        return {
          conn: c,
          url: resolved.url,
          alive: resolved.alive && resolved.sessionId === c.sessionId,
        };
      }),
    );

    spin.stop();

    const active = results.filter((r) => r.alive);

    if (active.length > 0) {
      p.intro("claude-connect");
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
