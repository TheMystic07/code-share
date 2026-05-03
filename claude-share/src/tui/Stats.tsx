import { Box, Text } from "ink";
import React from "react";

interface Props {
  publicUrl: string | null;
  lanUrl: string | null;
  loopbackUrl: string;
  pairingCode: string;
  localPort: number;
  sharedUntil: Date;
  totalRequests: number;
}

function formatExpiry(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m remaining`;
  return `${m}m remaining`;
}

export function Stats({
  publicUrl,
  lanUrl,
  loopbackUrl,
  pairingCode,
  localPort,
  sharedUntil,
  totalRequests,
}: Props) {
  const lanConnectUrl = lanUrl ? `${lanUrl}/connect/${pairingCode}` : null;
  const publicConnectUrl = publicUrl ? `${publicUrl}/connect/${pairingCode}` : null;
  const loopbackConnectUrl = `${loopbackUrl}/connect/${pairingCode}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        claude-share
      </Text>

      <Box flexDirection="column" marginTop={1} gap={0}>
        {lanConnectUrl && (
          <Box gap={1}>
            <Text dimColor>LAN: </Text>
            <Text bold color="green">
              {lanConnectUrl}
            </Text>
          </Box>
        )}
        {publicConnectUrl ? (
          <Box gap={1}>
            <Text dimColor>Tunnel: </Text>
            <Text color="green">{publicConnectUrl}</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Text dimColor>Tunnel: </Text>
            <Text color="yellow">starting…</Text>
          </Box>
        )}
        <Box gap={1}>
          <Text dimColor>Loopback: </Text>
          <Text dimColor>{loopbackConnectUrl}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Port: </Text>
          <Text>{localPort}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Session: </Text>
          <Text>{formatExpiry(sharedUntil)}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Requests: </Text>
          <Text>{totalRequests}</Text>
        </Box>
      </Box>
    </Box>
  );
}
