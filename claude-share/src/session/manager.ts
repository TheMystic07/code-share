import crypto from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { webcrypto } from "node:crypto";
function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

// base58 alphabet (Bitcoin alphabet — no 0/O/I/l)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(bytes: Uint8Array): string {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  const base = BigInt(58);
  const result: string[] = [];
  while (num > 0n) {
    result.push(BASE58_ALPHABET[Number(num % base)]);
    num /= base;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result.push(BASE58_ALPHABET[0]);
  }
  return result.reverse().join("");
}

export type SessionStatus = "waiting" | "active" | "expired" | "revoked";

export interface Connection {
  id: string;
  name: string;
  connectedAt: Date;
  requestCount: number;
  lastSeenAt: Date;
  status: SessionStatus;
}

export interface ConnectionFile {
  serverUrl: string;
  sessionId: string;
  caPem: string;
  // nonce and ciphertext stored as hex strings in the encrypted file
}

export interface Session {
  id: string;
  /** 256-bit session key */
  key: Uint8Array;
  /** First 10 bytes of key in base58 — shown to sharer and entered by receiver */
  pairingCode: string;
  sharedUntil: Date;
  connections: Map<string, Connection>;
  status: SessionStatus;
  createdAt: Date;
  pairingAttempts: Map<string, number>; // ip -> attempt count
}

let currentSession: Session | null = null;

export function createSession(durationMs: number): Session {
  const key = randomBytes(32);
  // Full key encoded as base58 — receiver uses this to decrypt the connection file
  const pairingCode = toBase58(key);

  currentSession = {
    id: crypto.randomUUID(),
    key,
    pairingCode,
    sharedUntil: new Date(Date.now() + durationMs),
    connections: new Map(),
    status: "waiting",
    createdAt: new Date(),
    pairingAttempts: new Map(),
  };
  return currentSession;
}

export function getSession(): Session | null {
  return currentSession;
}

/** Encrypts a ConnectionFile for delivery to receiver. Returns hex-encoded ciphertext+nonce blob. */
export function encryptConnectionFile(session: Session, file: ConnectionFile): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(file));
  const nonce = randomBytes(24); // XChaCha20 needs 24-byte nonce
  const cipher = xchacha20poly1305(session.key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  // Format: <24-byte nonce hex><ciphertext hex>
  return Buffer.from(nonce).toString("hex") + Buffer.from(ciphertext).toString("hex");
}

/** Decrypts a blob produced by encryptConnectionFile. */
export function decryptConnectionFile(session: Session, blob: string): ConnectionFile {
  const nonceHex = blob.slice(0, 48); // 24 bytes * 2
  const ctHex = blob.slice(48);
  const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
  const ciphertext = Uint8Array.from(Buffer.from(ctHex, "hex"));
  const cipher = xchacha20poly1305(session.key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionFile;
}

/** Constant-time pairing code check. Returns true if code matches. */
export function checkPairingCode(session: Session, ip: string, code: string): boolean {
  const attempts = session.pairingAttempts.get(ip) ?? 0;
  if (attempts >= 5) return false;

  const expected = Buffer.from(session.pairingCode, "utf8");
  const provided = Buffer.from(code.padEnd(session.pairingCode.length, "\0"), "utf8");
  const match = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);

  if (!match) {
    session.pairingAttempts.set(ip, attempts + 1);
  }
  return match;
}

export function addConnection(session: Session, name: string): Connection {
  const conn: Connection = {
    id: crypto.randomUUID(),
    name,
    connectedAt: new Date(),
    requestCount: 0,
    lastSeenAt: new Date(),
    status: "active",
  };
  session.connections.set(conn.id, conn);
  session.status = "active";
  return conn;
}

export function revokeConnection(session: Session, connectionId: string): boolean {
  const conn = session.connections.get(connectionId);
  if (!conn) return false;
  conn.status = "revoked";
  return true;
}

export function recordRequest(session: Session, connectionId: string): void {
  const conn = session.connections.get(connectionId);
  if (conn && conn.status === "active") {
    conn.requestCount++;
    conn.lastSeenAt = new Date();
  }
}

export function isSessionExpired(session: Session): boolean {
  return Date.now() > session.sharedUntil.getTime();
}

export function extendSession(session: Session, additionalMs: number): void {
  session.sharedUntil = new Date(session.sharedUntil.getTime() + additionalMs);
}

export function destroySession(): void {
  if (currentSession) {
    // Zero out the key before releasing
    currentSession.key.fill(0);
    currentSession = null;
  }
}
