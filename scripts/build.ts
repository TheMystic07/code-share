#!/usr/bin/env bun
// Build script. BORE_SERVER / BORE_PASSWORD from the environment are baked into
// the code-share bundle as *defaults*; at runtime a BORE_SERVER/BORE_PASSWORD
// env var or ~/.code-share/config.json (boreServer/boreSecret) still overrides.
//   BORE_SERVER=my.server BORE_PASSWORD=secret bun run build

function build(entry: string, outfile: string, extraArgs: string[] = []) {
  const result = Bun.spawnSync(
    ["bun", "build", entry, "--outfile", outfile, "--target", "node", "--production", ...extraArgs],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// When BORE_SERVER/BORE_PASSWORD are not given, fall back to the sharer config
// of the machine doing the build (~/.code-share/config.json). Releases are cut
// from a machine that already runs code-share, so this bakes the same tunnel
// server + secret that machine uses. Set BORE_PASSWORD="" explicitly to skip.
function localBoreConfig(): { server?: string; secret?: string } {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".code-share", "config.json"), "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return {
      server: typeof cfg["boreServer"] === "string" ? cfg["boreServer"] : undefined,
      secret: typeof cfg["boreSecret"] === "string" ? cfg["boreSecret"] : undefined,
    };
  } catch {
    return {};
  }
}
const local = localBoreConfig();
const bakedServer = process.env.BORE_SERVER || local.server || "tunnel.mystic.cat";
const bakedPassword =
  process.env.BORE_PASSWORD !== undefined
    ? process.env.BORE_PASSWORD
    : (local.server === undefined || local.server === bakedServer) && local.secret
      ? local.secret
      : "";
console.log(
  `[build] bore server ${bakedServer}, secret ${bakedPassword ? "baked" : "NOT baked — fresh installs will need boreSecret in config"}`,
);
const shareDefines: string[] = [
  "--define", `process.env.NODE_ENV="production"`,
  "--define", `process.env.CODE_SHARE_BAKED_BORE_SERVER=${JSON.stringify(bakedServer)}`,
  "--define", `process.env.CODE_SHARE_BAKED_BORE_PASSWORD=${JSON.stringify(bakedPassword)}`,
];

build("code-share/index.ts", "dist/code-share/index.js", shareDefines);
build("code-connect/index.ts", "dist/code-connect/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
]);
