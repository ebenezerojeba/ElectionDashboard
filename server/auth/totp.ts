/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — compatible with common authenticator apps. */
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpAt(secretB32: string, timeMs: number): string {
  return hotp(base32Decode(secretB32), Math.floor(timeMs / 30000));
}

/** Returns the matched time step (for replay protection) or null. Accepts ±1 step of clock drift. */
export function verifyTotp(secretB32: string, code: string, timeMs = Date.now(), lastStep?: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(timeMs / 30000);
  const key = base32Decode(secretB32);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep !== undefined && s <= lastStep) continue;
    if (hotp(key, s) === code) return s;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'Lagos EIP'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
