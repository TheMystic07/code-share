const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(bytes: Uint8Array): string {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  const result: string[] = [];
  while (num > 0n) {
    result.push(ALPHABET[Number(num % 58n)]);
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result.push(ALPHABET[0]);
  }
  return result.reverse().join("");
}

export function fromBase58(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(20, "0"); // at least 10 bytes
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
