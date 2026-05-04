import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".claude-share", "logs");
const LOG_FILE = path.join(LOG_DIR, "share.log");

function write(level: "INFO" | "WARN" | "ERROR", message: string, extra?: unknown): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const suffix = extra !== undefined ? " " + (extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra)) : "";
    fs.appendFileSync(LOG_FILE, `${ts} [${level}] ${message}${suffix}\n`);
  } catch {}
}

export const logger = {
  info:  (msg: string, extra?: unknown) => write("INFO",  msg, extra),
  warn:  (msg: string, extra?: unknown) => write("WARN",  msg, extra),
  error: (msg: string, extra?: unknown) => write("ERROR", msg, extra),
};
