import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ---------- Keyed hashing (pseudonymisation) ----------

/** HMAC-SHA256 truncated to 16 bytes (32 hex chars). */
export function hmac16(keyHex: string, data: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data, 'utf8').digest('hex').slice(0, 32);
}

export const recordIdOf = (key: string, puCode: string, vin: string) => hmac16(key, `rec|${puCode}|${vin.toUpperCase()}`);
export const vinHashOf = (key: string, vin: string) => hmac16(key, `vin|${vin.toUpperCase()}`);
/** Name key ignores gender because one source copy has an unreliable gender field. */
export const nameKeyOf = (key: string, normalisedName: string, birthYear: number | null) =>
  hmac16(key, `name|${normalisedName}|${birthYear ?? ''}`);

// ---------- Symmetric encryption (AES-256-GCM) for small secrets ----------

export function encrypt(keyHex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(keyHex: string, payload: string): string {
  const [v, ivB, tagB, ctB] = payload.split(':');
  if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

// ---------- Passwords (scrypt) ----------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB, dkB] = parts;
  const expected = Buffer.from(dkB!, 'base64');
  const dk = await scrypt(pw, Buffer.from(saltB!, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

/** Password policy: at least 12 characters with letters and digits. */
export function passwordProblems(pw: string): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push('must be at least 12 characters');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) p.push('must contain letters and digits');
  return p;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
