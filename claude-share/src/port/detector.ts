import net from "node:net";

type Handler = (socket: net.Socket) => void;

interface PortDetectorOptions {
  onConnect: Handler; // HTTP CONNECT (proxy traffic)
  onHttp: Handler; // plain HTTP (API server traffic)
}

/**
 * Creates a single TCP server that routes connections by sniffing the first bytes.
 * CONNECT requests go to the MITM proxy; everything else goes to the Hono HTTP server.
 */
export function createPortDetector(options: PortDetectorOptions): net.Server {
  return net.createServer((socket) => {
    socket.once("data", (chunk) => {
      // HTTP CONNECT starts with "CONNECT "
      const isConnect = chunk.slice(0, 8).toString("ascii").toUpperCase().startsWith("CONNECT");

      // Unshift the chunk back so the handler sees a complete stream
      const handler = isConnect ? options.onConnect : options.onHttp;
      socket.unshift(chunk);
      handler(socket);
    });

    socket.on("error", (err) => {
      // Ignore connection resets — common during tunnel setup
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error("[detector] socket error:", err.message);
      }
    });
  });
}
