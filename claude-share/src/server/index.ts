import { Hono } from "hono";
import {
  getSession,
  checkPairingCode,
  addConnection,
  revokeConnection,
  encryptConnectionFile,
  isSessionExpired,
  type ConnectionFile,
} from "../session/manager.js";

export function createApiApp(publicUrl: string, caPem: string): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const session = getSession();
    return c.json({
      ok: true,
      sessionActive: !!session && !isSessionExpired(session),
    });
  });

  /**
   * POST /pair
   * Body: { code: string, name: string }
   * Returns: { blob: string } — XChaCha20-encrypted connection file hex
   */
  app.post("/pair", async (c) => {
    const session = getSession();
    if (!session || isSessionExpired(session)) {
      return c.json({ error: "No active session" }, 503);
    }

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const body = await c.req.json<{ code?: string; name?: string }>();
    const code = body.code?.trim() ?? "";
    const name = body.name?.trim() ?? "receiver";

    if (!checkPairingCode(session, ip, code)) {
      return c.json({ error: "Invalid pairing code" }, 401);
    }

    const conn = addConnection(session, name);

    const file: ConnectionFile = {
      serverUrl: publicUrl,
      sessionId: session.id,
      caPem,
    };

    const blob = encryptConnectionFile(session, file);
    return c.json({ blob, connectionId: conn.id });
  });

  /** GET /sessions — list active connections (for TUI or remote inspection) */
  app.get("/sessions", (c) => {
    const session = getSession();
    if (!session) return c.json({ connections: [] });

    const connections = Array.from(session.connections.values()).map((conn) => ({
      id: conn.id,
      name: conn.name,
      connectedAt: conn.connectedAt.toISOString(),
      requestCount: conn.requestCount,
      lastSeenAt: conn.lastSeenAt.toISOString(),
      status: conn.status,
    }));

    return c.json({
      connections,
      sharedUntil: session.sharedUntil.toISOString(),
      sessionId: session.id,
    });
  });

  /** DELETE /sessions/:id — revoke a connection */
  app.delete("/sessions/:id", (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No session" }, 404);

    const id = c.req.param("id");
    const ok = revokeConnection(session, id);
    if (!ok) return c.json({ error: "Connection not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
