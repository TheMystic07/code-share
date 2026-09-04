/** Which CLI's subscription a share session carries. One tool per session. */
export type ShareTool = "claude" | "codex";

export const SHARE_TOOLS: readonly ShareTool[] = ["claude", "codex"];

export function isShareTool(value: unknown): value is ShareTool {
  return value === "claude" || value === "codex";
}

/** Accepts the flag spellings users are likely to type. */
export function parseShareTool(value: unknown): ShareTool | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "claude" || v === "claude-code" || v === "anthropic") return "claude";
  if (v === "codex" || v === "chatgpt" || v === "openai") return "codex";
  return null;
}

export function toolLabel(tool: ShareTool): string {
  return tool === "codex" ? "ChatGPT (Codex)" : "Claude Code";
}

/** Executable name of the CLI on the receiver. */
export function toolBinary(tool: ShareTool): string {
  return tool === "codex" ? "codex" : "claude";
}

/** What the sharer must run to fix a dead login. */
export function toolLoginCommand(tool: ShareTool): string {
  return tool === "codex" ? "codex login" : "claude login";
}
