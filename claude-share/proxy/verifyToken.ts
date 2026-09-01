import { execFile } from "node:child_process";

import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { logger } from "../logger";
import { getTokenStatus, initToken } from "./token";

// Last-resort fallback: let Claude Code itself refresh (it may hold a newer
// refresh token in some edge cases, e.g. a different credential backend).
function spawnClaudeForRefresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = process.platform === "win32" ? "claude.cmd" : "claude";
    const child = execFile(
      bin,
      ["-p", "hi"],
      { timeout: 60_000, shell: process.platform === "win32" },
      (err) => {
        if (err?.killed) reject(new Error("Claude process timed out after 60s"));
        else resolve();
      },
    );
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

export async function verifyTokenOrExit(): Promise<void> {
  const exists = await platform().credentialsExist();
  if (!exists) {
    p.log.error(
      "Could not find Claude Code credentials on this machine.\n" +
        "Run 'claude' and log in, then restart claude-share.",
    );
    process.exit(1);
  }

  const spin = p.spinner();
  spin.start("Checking Anthropic credentials…");

  try {
    await initToken();
  } catch (err) {
    logger.warn("[token] initial refresh failed", err);
  }

  let st = getTokenStatus();
  if (st.state === "ok" && st.expiresAt && st.expiresAt > Date.now()) {
    const mins = Math.round((st.expiresAt - Date.now()) / 60000);
    spin.stop(`Credentials OK — auto-refresh enabled (token valid for ${mins} min).`);
    return;
  }

  // Refresh failed. Try the Claude Code fallback once, then re-check.
  spin.message("Token refresh failed — trying via Claude Code…");
  try {
    await spawnClaudeForRefresh();
  } catch (err) {
    logger.warn("[token] claude spawn error", err);
  }
  try {
    await initToken();
  } catch {}

  st = getTokenStatus();
  if (st.state === "ok" && st.expiresAt && st.expiresAt > Date.now()) {
    spin.stop("Credentials refreshed.");
    return;
  }
  // The access token may still be valid even if refresh failed; allow sharing but warn.
  if (st.expiresAt && st.expiresAt > Date.now()) {
    spin.stop(`Sharing with current token; automatic refresh is failing: ${st.lastError ?? "unknown"}`);
    p.log.warn("If the token expires and cannot be refreshed, run 'claude login' on this machine.");
    return;
  }

  spin.stop("Token is expired and could not be refreshed.");
  p.log.error(
    (st.lastError ? `${st.lastError}\n` : "") +
      "Re-login on this machine: claude logout && claude login\n" +
      "Then restart claude-share.",
  );
  process.exit(1);
}
