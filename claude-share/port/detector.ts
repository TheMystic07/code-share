import net from "node:net";

import { logger } from "../logger";

type Handler = (socket: net.Socket) => void;

interface PortDetectorOptions {
  onConnect: Handler; // HTTP CONNECT (proxy traffic)
  onHttp: Handler; // plain HTTP (API server traffic)
  onTls: Handler; // TLS ClientHello (HTTPS API traffic)
}

/**
 * Creates a single TCP server that routes connections by sniffing the first bytes.
 * CONNECT → MITM proxy; TLS ClientHello → HTTPS API; plain HTTP → HTTP API.
 */
export function createPortDetector(options: PortDetectorOptions): net.Server {
  return net.createServer((socket) => {
    socket.once("data", (chunk) => {
      // HTTP CONNECT starts with "CONNECT "
      const isConnect = chunk.slice(0, 8).toString("ascii").toUpperCase().startsWith("CONNECT");
      // TLS ClientHello starts with 0x16 (content type: handshake)
      const isTls = !isConnect && chunk[0] === 0x16;

      const handler = isConnect ? options.onConnect : isTls ? options.onTls : options.onHttp;
      socket.unshift(chunk);
      handler(socket);
    });

    socket.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        logger.error("[detector] socket error", err);
      }
    });
  });
}

