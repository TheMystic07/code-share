import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import type { ConnectionFile } from "./types.js";

// ── Base58 decode ────────────────────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fromBase58(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(20, "0"); // at least 10 bytes
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

// ── Decryption (mirrors session/manager.ts in claude-share) ─────────────────

export function decryptBlob(blob: string, pairingCode: string): ConnectionFile {
  // Pairing code is the full 32-byte session key encoded in base58
  const codeBytes = fromBase58(pairingCode);
  if (codeBytes.length < 32) throw new Error("Pairing code too short");
  const key = codeBytes.slice(0, 32);

  const nonceHex = blob.slice(0, 48);
  const ctHex = blob.slice(48);
  const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
  const ciphertext = Uint8Array.from(Buffer.from(ctHex, "hex"));

  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionFile;
}

// ── Connect URL ───────────────────────────────────────────────────────────────
// Format: http://host:port/connect/<pairingCode>
// The server does not need to handle this path — it's parsed client-side only.

export function parseConnectUrl(
  url: string,
): { serverUrl: string; pairingCode: string } | null {
  const match = url.match(/^(https?:\/\/.+?)\/connect\/([A-Za-z0-9]+)$/);
  if (!match) return null;
  return { serverUrl: match[1], pairingCode: match[2] };
}
