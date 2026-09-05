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

/**
 * Picks the runnable file from `where`/`which` output. On Windows `where` also
 * lists the extensionless POSIX shim npm installs next to `.cmd`, which Node
 * cannot spawn (ENOENT). Prefer .exe, then .cmd/.bat; never the bare script.
 */
export function pickExecutable(candidates: string[]): string | null {
  const list = candidates.map((c) => c.trim()).filter(Boolean);
  if (list.length === 0) return null;
  if (process.platform !== "win32") return list[0]!;
  return (
    list.find((c) => /\.exe$/i.test(c)) ??
    list.find((c) => /\.(cmd|bat)$/i.test(c)) ??
    list.find((c) => /\.[a-z0-9]+$/i.test(c) && !/\.(ps1|sh)$/i.test(c)) ??
    null
  );
}
