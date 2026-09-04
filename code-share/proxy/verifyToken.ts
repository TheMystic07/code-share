import { execFile } from "node:child_process";

import * as p from "@clack/prompts";

import { codexCredentialsExist } from "@shared/codex/store";
import { platform } from "@shared/platforms";
import { type ShareTool, toolLabel, toolLoginCommand } from "@shared/tool";
import { logger } from "../logger";
import { getActiveTool, getTokenStatus, initToken } from "./token";

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

async function credentialsExist(tool: ShareTool): Promise<boolean> {
  if (tool === "codex") return codexCredentialsExist();
  return platform().credentialsExist();
}

export async function verifyTokenOrExit(): Promise<void> {
  const tool = getActiveTool();
  const label = toolLabel(tool);
  const login = toolLoginCommand(tool);

  const exists = await credentialsExist(tool);
  if (!exists) {
    p.log.error(
      `Could not find ${label} credentials on this machine.\n` +
        (tool === "codex"
          ? "Run 'codex' and sign in with ChatGPT (or 'codex login'), then restart code-share.\n" +
            "API-key logins cannot be shared — a ChatGPT login is required."
          : "Run 'claude' and log in, then restart code-share."),
    );
    process.exit(1);
  }

  const spin = p.spinner();
  spin.start(`Checking ${label} credentials…`);

  try {
    await initToken();
  } catch (err) {
    logger.warn(`[token] initial ${tool} refresh failed`, err);
  }

  let st = getTokenStatus();
  if (st.state === "ok" && st.expiresAt && st.expiresAt > Date.now()) {
    const mins = Math.round((st.expiresAt - Date.now()) / 60000);
    spin.stop(`Credentials OK — auto-refresh enabled (token valid for ${mins} min).`);
    return;
  }

  if (tool === "claude") {
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
  }

  // The access token may still be valid even if refresh failed; allow sharing but warn.
  if (st.expiresAt && st.expiresAt > Date.now()) {
    spin.stop(`Sharing with current token; automatic refresh is failing: ${st.lastError ?? "unknown"}`);
    p.log.warn(`If the token expires and cannot be refreshed, run '${login}' on this machine.`);
    return;
  }

  spin.stop("Token is expired and could not be refreshed.");
  p.log.error(
    (st.lastError ? `${st.lastError}\n` : "") +
      (tool === "codex"
        ? "Re-login on this machine: codex logout && codex login\n"
        : "Re-login on this machine: claude logout && claude login\n") +
      "Then restart code-share.",
  );
  process.exit(1);
}
