import { Hono } from "hono";

import {
  getSession,
  checkPairingCode,
  addMachine,
  encryptConnectionFile,
  isSessionExpired,
  addMachineSession,
  endMachineSession,
  heartbeatMachineSession,
  type ConnectionFile,
  type SharerAccount,
} from "../session/manager.js";

interface Urls {
  public: string | null;
  lan: string | null;
}

export function createApiApp(urls: Urls, caPem: string, sharerAccount: SharerAccount | null): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const session = getSession();
    return c.json({
      ok: true,
      sessionActive: !!session && !isSessionExpired(session),
      sessionId: session?.id ?? null,
    });
  });

  /** POST /pair — one-time pairing with a machine */
  app.post("/pair", async (c) => {
    const session = getSession();
    if (!session || isSessionExpired(session)) return c.json({ error: "No active session" }, 503);

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const body = await c.req.json<{ code?: string; name?: string }>();
    const code = body.code?.trim() ?? "";
    const name = body.name?.trim() ?? "unknown device";

    if (!checkPairingCode(session, ip, code)) return c.json({ error: "Invalid pairing code" }, 401);

    const machine = addMachine(session, name);

    const file: ConnectionFile = {
      publicServerUrl: urls.public,
      lanServerUrl: urls.lan,
      sessionId: session.id,
      sharedUntil: session.sharedUntil.toISOString(),
      caPem,
      sharerAccount,
    };

    const blob = encryptConnectionFile(session, file);
    return c.json({ blob, machineId: machine.id });
  });

  /** POST /session/start — receiver opened a Claude session */
  app.post("/session/start", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId } = await c.req.json<{ machineId: string }>();
    const ms = addMachineSession(session, machineId);
    if (!ms) return c.json({ error: "Machine not found" }, 404);
    return c.json({ ok: true, sessionId: ms.id });
  });

  /** POST /session/end — receiver closed a Claude session */
  app.post("/session/end", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, sessionId } = await c.req.json<{ machineId: string; sessionId: string }>();
    endMachineSession(session, machineId, sessionId);
    return c.json({ ok: true });
  });

  /** POST /session/heartbeat — receiver is still alive */
  app.post("/session/heartbeat", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, sessionId } = await c.req.json<{ machineId: string; sessionId: string }>();
    heartbeatMachineSession(session, machineId, sessionId);
    return c.json({ ok: true });
  });

  /** GET /machines — list machines and their sessions */
  app.get("/machines", (c) => {
    const session = getSession();
    if (!session) return c.json({ machines: [] });
    const machines = [...session.machines.values()].map((m) => ({
      id: m.id,
      name: m.name,
      pairedAt: m.pairedAt.toISOString(),
      sessions: [...m.sessions.values()].map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        active: s.active,
      })),
    }));
    return c.json({ machines, sharedUntil: session.sharedUntil.toISOString() });
  });

  return app;
}
