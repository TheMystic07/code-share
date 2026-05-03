import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";

import { getEntries, subscribe, type RequestEntry } from "../proxy/requestLog.js";

const OUTCOME_COLOR: Record<string, string> = {
  allowed: "green",
  blocked: "red",
};

const OUTCOME_ICON: Record<string, string> = {
  allowed: "✓",
  blocked: "✕",
};

function formatTime(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function RequestLog() {
  const [entries, setEntries] = useState<readonly RequestEntry[]>(getEntries());

  useEffect(() => {
    const unsub = subscribe(() => setEntries([...getEntries()]));
    return unsub;
  }, []);

  const visible = entries.slice(0, 20);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        ── request log (dev) ───────────────────────────────────────────────────
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>No requests yet.</Text>
      ) : (
        visible.map((e) => (
          <Box key={e.id} gap={1}>
            <Text dimColor>{formatTime(e.ts)}</Text>
            <Text color={OUTCOME_COLOR[e.outcome]}>{OUTCOME_ICON[e.outcome]}</Text>
            <Text bold color="white">
              {e.method.padEnd(4)}
            </Text>
            <Text dimColor>{truncate(e.hostname, 30)}</Text>
            <Text>{truncate(e.path, 40)}</Text>
            {e.status !== null && <Text color={e.status >= 400 ? "red" : "green"}>{e.status}</Text>}
          </Box>
        ))
      )}
    </Box>
  );
}
