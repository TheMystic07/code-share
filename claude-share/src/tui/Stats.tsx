import React from "react";
import { Box, Text } from "ink";

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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        claude-share
      </Text>

      <Box flexDirection="column" marginTop={1} gap={0}>
        {publicUrl ? (
          <Box gap={1}>
            <Text dimColor>Public (tunnel):</Text>
            <Text color="green">{publicUrl}</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Text dimColor>Public (tunnel):</Text>
            <Text color="yellow">starting…</Text>
          </Box>
        )}
        {lanUrl && (
          <Box gap={1}>
            <Text dimColor>LAN: </Text>
            <Text color="white">{lanUrl}</Text>
          </Box>
        )}
        <Box gap={1}>
          <Text dimColor>Loopback: </Text>
          <Text dimColor>{loopbackUrl}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Local port:</Text>
          <Text>{localPort}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Pairing code:</Text>
          <Text bold color="yellow">
            {pairingCode}
          </Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Session:</Text>
          <Text>{formatExpiry(sharedUntil)}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Requests:</Text>
          <Text>{totalRequests}</Text>
        </Box>
      </Box>
    </Box>
  );
}
