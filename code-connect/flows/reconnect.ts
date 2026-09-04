import * as p from "@clack/prompts";

import { resolveActiveUrl } from "../health";
import { launchTool } from "../launch";
import { toolLabel } from "@shared/tool";
import { loadConnections } from "../storage";
import type { SavedConnection } from "../types";

export async function reconnectFlow(
  uuid?: string,
  extraArgs: string[] = [],
  launchOpts: { noUpdate?: boolean } = {},
) {
  const connections = loadConnections();

  if (connections.length === 0) {
    p.log.warn("No saved connections. Run without flags to pair.");
    process.exit(0);
  }

  let chosen: SavedConnection;

  if (uuid) {
    const match = connections.find((c) => c.id.startsWith(uuid));
    if (!match) {
      p.log.error(`No connection matching ${uuid}`);
      process.exit(1);
    }
    chosen = match;
  } else {
    p.intro("code-connect — reconnect");
    const pick = await p.select({
      message: "Choose a connection:",
      options: connections.map((c) => ({
        value: c.id,
        label: `${c.systemName} — ${c.lanServerUrl ?? c.publicServerUrl ?? ""}`,
        hint: `${toolLabel(c.tool ?? "claude")} · saved ${new Date(c.savedAt).toLocaleDateString()}`,
      })),
    });
    if (p.isCancel(pick)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    chosen = connections.find((c) => c.id === pick)!;
  }

  const spin = p.spinner();
  spin.start(`Checking ${chosen.systemName}...`);
  const resolved = await resolveActiveUrl(chosen);
  if (!resolved.alive) {
    spin.stop("Server offline or session expired.");
    process.exit(1);
  }
  spin.stop("Server is alive.");

  await launchTool(
    resolved.url,
    chosen.caPem,
    chosen,
    extraArgs,
    chosen.sharerAccount ?? null,
    launchOpts,
  );
}
