/**
 * Resets passwords for users in the CLOUD database (reads .env.cloud).
 *   npx tsx scripts/cloud-reset-password.ts admin@pitch.local executive@pitch.local
 * Prints each new password once. Clears lockouts and ends existing sessions.
 */
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { hashPassword } from '../server/crypto.js';

dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
const env = readFileSync('.env.cloud', 'utf8');
const uri = /^CLOUD_MONGODB_URI=(.*)$/m.exec(env)![1]!.trim();
const dbName = /^CLOUD_MONGODB_DB=(.*)$/m.exec(env)?.[1]?.trim() || 'lagos_eip_cloud';
const emails = process.argv.slice(2).map((e) => e.toLowerCase());
if (!emails.length) throw new Error('Give at least one email');

const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 20000 });
const db = client.db(dbName);
for (const email of emails) {
  const u = await db.collection('users').findOne({ email });
  if (!u) {
    console.log(`${email}: not found`);
    continue;
  }
  // Easy to type, still strong: 3 groups of 4 letters/digits + a digit.
  const raw = randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const password = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${Math.floor(Math.random() * 9) + 1}`;
  await db.collection('users').updateOne(
    { _id: u._id },
    { $set: { passwordHash: await hashPassword(password), mustChangePassword: false, failedLogins: 0, status: 'active', updatedAt: new Date() }, $unset: { lockedUntil: '' } },
  );
  await db.collection('sessions').deleteMany({ userId: u._id });
  await db.collection('audit_events').insertOne({ at: new Date(), action: 'user.password_reset', outcome: 'success', target: email, detail: { via: 'cli' } });
  console.log(`${email}  ${password}`);
}
await client.close();
