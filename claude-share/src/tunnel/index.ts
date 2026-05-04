import { spawn } from "node:child_process";

export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}

export function startTunnel(localPort: number, onDown?: () => void): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bore", ["local", String(localPort), "--to", "bore.pub"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let closing = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("bore timed out — is it installed? (cargo install bore-cli)"));
      }
    }, 30_000);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      // bore prints: "listening at bore.pub:<port>"
      const match = text.match(/listening at bore\.pub:(\d+)/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        const port = match[1];
        resolve({
          publicUrl: `http://bore.pub:${port}`,
          close() {
            closing = true;
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
        reject(new Error(`bore exited with code ${code}`));
      } else if (!closing) {
        onDown?.();
      }
    });
  });
}
