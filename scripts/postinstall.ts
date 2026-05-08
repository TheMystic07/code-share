#!/usr/bin/env node
import ProtocolRegistry from "protocol-registry";

await ProtocolRegistry.register(
  "claudeshare",
  `claude-connect --share="$_URL_"`,
  { override: true, terminal: true },
).catch((err: unknown) => {
  // Non-fatal: registration failing shouldn't break the install
  process.stderr.write(`[claude-share] protocol registration failed: ${err}\n`);
});
