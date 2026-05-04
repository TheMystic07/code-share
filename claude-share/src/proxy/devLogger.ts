import fs from "node:fs";
import path from "node:path";

export const LOG_FILE = path.resolve("claude-share-dev.log");

const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

const MAX_BODY = 64 * 1024; // 64 KB

export type RequestOutcome = "INTERCEPTED" | "BLOCKED" | "PASSED";

export interface DevLogEntry {
  ts: string;
  outcome: RequestOutcome;
  method: string;
  host: string;
  path: string;
  requestHeaders: Record<string, string | string[] | undefined>;
  requestBody: string;
  httpStatus: number | null;
  responseHeaders: Record<string, string | string[] | undefined> | null;
}

export function writeDevLog(entry: DevLogEntry): void {
  stream.write(JSON.stringify(entry) + "\n");
}

export function truncate(buf: Buffer): string {
  if (buf.length > MAX_BODY) {
    return (
      buf.subarray(0, MAX_BODY).toString("utf8") + `\n…[truncated ${buf.length - MAX_BODY} bytes]`
    );
  }
  return buf.toString("utf8");
}
