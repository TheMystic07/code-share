import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".claude-share", "logs");

function write(logFile: string, level: "INFO" | "WARN" | "ERROR", message: string, extra?: unknown): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const suffix =
      extra !== undefined
        ? " " + (extra instanceof Error ? (extra.stack ?? extra.message) : JSON.stringify(extra))
        : "";
    fs.appendFileSync(logFile, `${ts} [${level}] ${message}${suffix}\n`);
  } catch {}
}

export function createLogger(filename: string) {
  const logFile = path.join(LOG_DIR, filename);
  return {
    info:  (msg: string, extra?: unknown) => write(logFile, "INFO",  msg, extra),
    warn:  (msg: string, extra?: unknown) => write(logFile, "WARN",  msg, extra),
    error: (msg: string, extra?: unknown) => write(logFile, "ERROR", msg, extra),
  };
}
