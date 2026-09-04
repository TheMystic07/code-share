import { spawn } from "node:child_process";

/** Runs a command with inherited stdio and a hard timeout; resolves to its exit code. */
export function run(cmd: string, args: string[], opts: { timeout: number; shell?: boolean }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: opts.shell ?? false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), opts.timeout);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}
