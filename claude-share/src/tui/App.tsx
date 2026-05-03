import { Box, Text, useInput, useApp } from "ink";
import React, { useState, useEffect } from "react";

import { getEntries, subscribe } from "../proxy/requestLog.js";
import { getSession, revokeConnection, type Connection } from "../session/manager.js";
import { RequestLog } from "./RequestLog.js";
import { Sessions } from "./Sessions.js";
import { Stats } from "./Stats.js";

const IS_DEV = process.env.NODE_ENV === "development";

interface Props {
  publicUrl: string | null;
  lanUrl: string | null;
  loopbackUrl: string;
  pairingCode: string;
  localPort: number;
  sharedUntil: Date;
  onRevoke: (id: string) => void;
  onExit: () => void;
}

export function App({
  publicUrl,
  lanUrl,
  loopbackUrl,
  pairingCode,
  localPort,
  sharedUntil,
  onRevoke,
  onExit,
}: Props) {
  const { exit } = useApp();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [totalRequests, setTotalRequests] = useState(0);

  // Poll session connections every second
  useEffect(() => {
    const interval = setInterval(() => {
      const session = getSession();
      if (!session) return;
      setConnections(Array.from(session.connections.values()));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Count allowed requests reactively from the request log
  useEffect(() => {
    const count = () =>
      setTotalRequests(getEntries().filter((e) => e.outcome === "allowed").length);
    count();
    return subscribe(count);
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
        lanUrl={lanUrl}
        loopbackUrl={loopbackUrl}
        pairingCode={pairingCode}
        localPort={localPort}
        sharedUntil={sharedUntil}
        totalRequests={totalRequests}
      />
      <Sessions connections={connections} onRevoke={handleRevoke} />
      {IS_DEV && <RequestLog />}
      <Box marginTop={1}>
        <Text dimColor>Press q to stop sharing and disconnect all receivers</Text>
      </Box>
    </Box>
  );
}
