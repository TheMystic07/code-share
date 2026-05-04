import crypto from "node:crypto";
import { webcrypto } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

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

export interface MachineSession {
  id: string;
  startedAt: Date;
  lastActiveAt: Date;
  active: boolean;
}

export interface Machine {
  id: string;
  name: string;
  pairedAt: Date;
  sessions: Map<string, MachineSession>;
}

export interface SharerAccount {
  emailAddress: string;
  displayName: string;
  organizationName: string;
}

export interface ConnectionFile {
  publicServerUrl: string | null;
  lanServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601
  caPem: string;
  sharerAccount: SharerAccount | null;
}

export interface Session {
  id: string;
  /** Current pairing key — replaced each time a new pairing code is generated */
  key: Uint8Array;
  pairingCode: string;
  /** True after a machine successfully pairs with this code */
  pairingCodeUsed: boolean;
  sharedUntil: Date;
  machines: Map<string, Machine>;
  status: SessionStatus;
  createdAt: Date;
  pairingAttempts: Map<string, number>;
}

let currentSession: Session | null = null;

export function createSession(durationMs: number): Session {
  const key = randomBytes(32);
  currentSession = {
    id: crypto.randomUUID(),
    key,
    pairingCode: toBase58(key),
    pairingCodeUsed: false,
    sharedUntil: new Date(Date.now() + durationMs),
    machines: new Map(),
    status: "waiting",
    createdAt: new Date(),
    pairingAttempts: new Map(),
  };
  return currentSession;
}

export function getSession(): Session | null {
  return currentSession;
}

/** Generates a fresh pairing code + key, allowing one more machine to pair. */
export function regeneratePairingCode(session: Session): void {
  const newKey = randomBytes(32);
  session.key = newKey;
  session.pairingCode = toBase58(newKey);
  session.pairingCodeUsed = false;
  session.pairingAttempts.clear();
}

/** Encrypts a ConnectionFile for delivery to receiver. Returns hex-encoded blob. */
export function encryptConnectionFile(session: Session, file: ConnectionFile): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(file));
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(session.key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return Buffer.from(nonce).toString("hex") + Buffer.from(ciphertext).toString("hex");
}

/** Constant-time pairing code check. Returns false if already used or brute-forced. */
export function checkPairingCode(session: Session, ip: string, code: string): boolean {
  if (session.pairingCodeUsed) return false;

  const attempts = session.pairingAttempts.get(ip) ?? 0;
  if (attempts >= 5) return false;

  const expected = Buffer.from(session.pairingCode, "utf8");
  const provided = Buffer.from(code.padEnd(session.pairingCode.length, "\0"), "utf8");
  const match = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);

  if (!match) session.pairingAttempts.set(ip, attempts + 1);
  return match;
}

function deduplicateName(session: Session, baseName: string): string {
  const names = new Set([...session.machines.values()].map((m) => m.name));
  if (!names.has(baseName)) return baseName;
  let i = 2;
  while (names.has(`${baseName} (${i})`)) i++;
  return `${baseName} (${i})`;
}

/** Creates a Machine entry and burns the current pairing code (one-time use). */
export function addMachine(session: Session, name: string): Machine {
  const machine: Machine = {
    id: crypto.randomUUID(),
    name: deduplicateName(session, name),
    pairedAt: new Date(),
    sessions: new Map(),
  };
  session.machines.set(machine.id, machine);
  session.pairingCodeUsed = true;
  session.status = "active";
  return machine;
}

export function addMachineSession(session: Session, machineId: string): MachineSession | null {
  const machine = session.machines.get(machineId);
  if (!machine) return null;
  const ms: MachineSession = {
    id: crypto.randomUUID(),
    startedAt: new Date(),
    lastActiveAt: new Date(),
    active: true,
  };
  machine.sessions.set(ms.id, ms);
  return ms;
}

export function endMachineSession(
  session: Session,
  machineId: string,
  sessionId: string,
): boolean {
  const ms = session.machines.get(machineId)?.sessions.get(sessionId);
  if (!ms) return false;
  ms.active = false;
  ms.lastActiveAt = new Date();
  return true;
}

export function heartbeatMachineSession(
  session: Session,
  machineId: string,
  sessionId: string,
): boolean {
  const ms = session.machines.get(machineId)?.sessions.get(sessionId);
  if (!ms?.active) return false;
  ms.lastActiveAt = new Date();
  return true;
}

export function isSessionExpired(session: Session): boolean {
  return Date.now() > session.sharedUntil.getTime();
}

export function destroySession(): void {
  if (currentSession) {
    currentSession.key.fill(0);
    currentSession = null;
  }
}
