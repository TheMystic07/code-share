import React from "react";
import { Box, Text } from "ink";
import type { Connection } from "../session/manager.js";

interface Props {
  connections: Connection[];
  onRevoke: (id: string) => void;
}

function formatDuration(from: Date): string {
  const secs = Math.floor((Date.now() - from.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function Sessions({ connections, onRevoke }: Props) {
  const active = connections.filter((c) => c.status === "active");

  if (active.length === 0) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text dimColor>No active connections. Waiting for receivers to pair...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Active connections ({active.length})</Text>
      {active.map((conn) => (
        <Box key={conn.id} flexDirection="row" gap={2} marginTop={1}>
          <Text color="green">●</Text>
          <Box flexDirection="column">
            <Text bold>{conn.name}</Text>
            <Text dimColor>
              {conn.requestCount} req · connected {formatDuration(conn.connectedAt)} ago
            </Text>
            <Text dimColor color="yellow">
              id: {conn.id.slice(0, 8)}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
