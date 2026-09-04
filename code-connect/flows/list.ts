import { toolLabel } from "@shared/tool";
import { resolveActiveUrl } from "../health";
import { loadConnections } from "../storage";

export async function listFlow() {
  const connections = loadConnections();
  if (connections.length === 0) {
    process.stdout.write("No saved connections.\n");
    return;
  }

  process.stdout.write("\nSaved connections:\n\n");
  for (const c of connections) {
    const { alive, url } = await resolveActiveUrl(c);
    const status = alive
      ? "\x1b[32m● online\x1b[0m"
      : "\x1b[90m○ offline\x1b[0m";
    process.stdout.write(`  ${status}  ${c.systemName}  ${url}  [${toolLabel(c.tool ?? "claude")}]\n`);
    process.stdout.write(`           id: ${c.id}\n`);
    process.stdout.write(`           saved: ${new Date(c.savedAt).toLocaleString()}\n\n`);
  }
}
