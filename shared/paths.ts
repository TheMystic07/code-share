import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** App state dir (config, saved connections, logs, bore binary). */
export const APP_DIR = path.join(os.homedir(), ".code-share");

// One-time migration from the pre-rename location so terms, saved
// connections and device name survive the upgrade. Runs at import time,
// before anything else touches the directory.
const LEGACY_DIR = path.join(os.homedir(), ".claude-share");
try {
  if (!fs.existsSync(APP_DIR) && fs.existsSync(LEGACY_DIR)) {
    fs.renameSync(LEGACY_DIR, APP_DIR);
  }
} catch {
  // Fall through — a fresh ~/.code-share is created lazily by whoever needs it.
}
