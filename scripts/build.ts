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

const bakedServer = process.env.BORE_SERVER || "tunnel.mystic.cat";
const bakedPassword = process.env.BORE_PASSWORD || "";
const shareDefines: string[] = [
  "--define", `process.env.NODE_ENV="production"`,
  "--define", `process.env.CODE_SHARE_BAKED_BORE_SERVER=${JSON.stringify(bakedServer)}`,
  "--define", `process.env.CODE_SHARE_BAKED_BORE_PASSWORD=${JSON.stringify(bakedPassword)}`,
];

build("code-share/index.ts", "dist/code-share/index.js", shareDefines);
build("code-connect/index.ts", "dist/code-connect/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
]);
