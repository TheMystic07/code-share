#!/usr/bin/env bun
// Build script that bakes BORE_SERVER and BORE_PASSWORD into the code-share bundle at compile time.
// Override defaults by setting the env vars before running: BORE_SERVER=my.server bun run build

const boreServer = process.env.BORE_SERVER || "bore.pub";
const borePassword = process.env.BORE_PASSWORD || "";

function build(entry: string, outfile: string, extraArgs: string[] = []) {
  const result = Bun.spawnSync(
    [
      "bun", "build", entry,
      "--outfile", outfile,
      "--target", "node",
      "--production",
      ...extraArgs,
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

build("code-share/index.ts", "dist/code-share/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
  "--define", `process.env.BORE_SERVER=${JSON.stringify(boreServer)}`,
  "--define", `process.env.BORE_PASSWORD=${JSON.stringify(borePassword)}`,
]);

build("code-connect/index.ts", "dist/code-connect/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
]);
