import { resolveActiveUrl } from "../health.js";
import { loadConnections } from "../storage.js";

export async function listFlow() {
  const connections = loadConnections();
  if (connections.length === 0) {
    console.log("No saved connections.");
    return;
  }

  console.log("\nSaved connections:\n");
  for (const c of connections) {
    const { alive, url } = await resolveActiveUrl(c);
    const status = alive
      ? "\x1b[32m● online\x1b[0m"
      : "\x1b[90m○ offline\x1b[0m";
    console.log(`  ${status}  ${c.systemName}  ${url}`);
    console.log(`           id: ${c.id}`);
    console.log(`           saved: ${new Date(c.savedAt).toLocaleString()}\n`);
  }
}
