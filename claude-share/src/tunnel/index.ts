import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// cloudflared npm package ships the binary at bin/cloudflared
const require = createRequire(import.meta.url);
let cloudflaredBin: string;
try {
  cloudflaredBin = require.resolve("cloudflared/bin/cloudflared");
} catch {
  cloudflaredBin = "cloudflared"; // fall back to PATH
}

export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}

export function startTunnel(localPort: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      cloudflaredBin,
      ["tunnel", "--url", `http://localhost:${localPort}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("cloudflared timed out — is it installed?"));
      }
    }, 30_000);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      // cloudflared prints the public URL to stderr
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          publicUrl: match[0],
          close() {
            proc.kill();
          },
        });
      }
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}
