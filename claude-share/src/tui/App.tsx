import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Stats } from "./Stats.js";
import { Sessions } from "./Sessions.js";
import { getSession, revokeConnection, type Connection } from "../session/manager.js";

interface Props {
  publicUrl: string;
  pairingCode: string;
  localPort: number;
  sharedUntil: Date;
  onRevoke: (id: string) => void;
  onExit: () => void;
}

export function App({ publicUrl, pairingCode, localPort, sharedUntil, onRevoke, onExit }: Props) {
  const { exit } = useApp();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [totalRequests, setTotalRequests] = useState(0);

  // Poll session state every second
  useEffect(() => {
    const interval = setInterval(() => {
      const session = getSession();
      if (!session) return;
      const conns = Array.from(session.connections.values());
      setConnections([...conns]);
      setTotalRequests(conns.reduce((sum, c) => sum + c.requestCount, 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      onExit();
      exit();
    }
  });

  function handleRevoke(id: string) {
    const session = getSession();
    if (session) revokeConnection(session, id);
    onRevoke(id);
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Stats
        publicUrl={publicUrl}
        pairingCode={pairingCode}
        localPort={localPort}
        sharedUntil={sharedUntil}
        totalRequests={totalRequests}
      />
      <Sessions connections={connections} onRevoke={handleRevoke} />
      <Box marginTop={1}>
        <Text dimColor>Press q to stop sharing and disconnect all receivers</Text>
      </Box>
    </Box>
  );
}
