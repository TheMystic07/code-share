import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

const execFileAsync = promisify(execFile);

export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}

async function isBoreInstalled(): Promise<boolean> {
  try {
    await execFileAsync("which", ["bore"]);
    return true;
  } catch {
    return false;
  }
}

async function installBore(): Promise<void> {
  const plat = process.platform;

  let bin: string;
  let args: string[];
  let label: string;

  if (plat === "darwin") {
    try {
      await execFileAsync("which", ["brew"]);
      bin = "brew";
      args = ["install", "bore-cli"];
      label = "brew install bore-cli";
    } catch {
      bin = "cargo";
      args = ["install", "bore-cli"];
      label = "cargo install bore-cli";
    }
  } else if (plat === "linux") {
    bin = "cargo";
    args = ["install", "bore-cli"];
    label = "cargo install bore-cli";
  } else {
    throw new Error("Unsupported platform — install bore manually: https://github.com/ekzhang/bore");
  }

  const spin = p.spinner();
  spin.start(`Running: ${label}`);
  try {
    await execFileAsync(bin, args);
    spin.stop("bore installed.");
  } catch (err) {
    spin.stop("Installation failed.");
    throw new Error(`Could not install bore: ${(err as Error).message}`);
  }
}

/** Returns true if bore is ready to use, false if the user declined to install it. */
export async function ensureBore(): Promise<boolean> {
  if (await isBoreInstalled()) return true;

  const confirm = await p.confirm({
    message: "bore is not installed. Install it to allow sharing over the internet?",
  });

  if (p.isCancel(confirm) || !confirm) return false;

  await installBore();
  return true;
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
        reject(new Error("bore timed out"));
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
