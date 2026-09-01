#!/usr/bin/env bun
// Build script. If BORE_SERVER / BORE_PASSWORD are set in the environment they
// are baked into the code-share bundle at compile time; otherwise the bundle
// resolves them at runtime (env → ~/.code-share/config.json → bore.pub).
//   BORE_SERVER=my.server BORE_PASSWORD=secret bun run build

function build(entry: string, outfile: string, extraArgs: string[] = []) {
  const result = Bun.spawnSync(
    ["bun", "build", entry, "--outfile", outfile, "--target", "node", "--production", ...extraArgs],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

const shareDefines: string[] = ["--define", `process.env.NODE_ENV="production"`];
if (process.env.BORE_SERVER) {
  shareDefines.push("--define", `process.env.BORE_SERVER=${JSON.stringify(process.env.BORE_SERVER)}`);
}
if (process.env.BORE_PASSWORD) {
  shareDefines.push("--define", `process.env.BORE_PASSWORD=${JSON.stringify(process.env.BORE_PASSWORD)}`);
}

build("code-share/index.ts", "dist/code-share/index.js", shareDefines);
build("code-connect/index.ts", "dist/code-connect/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
]);
