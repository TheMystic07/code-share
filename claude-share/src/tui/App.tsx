import { execSync } from "node:child_process";

import { Box, Text, useInput, useApp } from "ink";
import React, { useState, useEffect, useRef } from "react";

import { getEntries, subscribe } from "../proxy/requestLog.js";
import { getSession, revokeConnection, type Connection } from "../session/manager.js";
import { RequestLog } from "./RequestLog.js";
import { Sessions } from "./Sessions.js";
import { Stats } from "./Stats.js";

const IS_DEV = process.env.NODE_ENV === "development";

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", { input: text });
    } else if (process.platform === "win32") {
      execSync("clip", { input: text });
    } else {
      execSync("xclip -selection clipboard", { input: text });
    }
    return true;
  } catch {
    return false;
  }
}

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
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (input === "c" && !key.ctrl) {
      const connectUrl =
        (publicUrl ? `${publicUrl}/connect/${pairingCode}` : null) ??
        (lanUrl ? `${lanUrl}/connect/${pairingCode}` : null) ??
        `${loopbackUrl}/connect/${pairingCode}`;
      const ok = copyToClipboard(connectUrl);
      if (ok) {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 2000);
      }
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
      <Box marginTop={1} gap={2}>
        <Text dimColor>Press q to quit</Text>
        {copied ? (
          <Text color="green">✓ Copied!</Text>
        ) : (
          <Text dimColor>Press c to copy connect link</Text>
        )}
      </Box>
    </Box>
  );
}
