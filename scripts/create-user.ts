/**
 * Bootstrap or add a user from the command line (e.g. the first System Administrator).
 *
 *   npm run user:create -- --email admin@example.org --name "Full Name" --role system_admin [--scope state | --lga 24-11 | --ward 24-11-03]
 *
 * A strong random temporary password is generated and printed once. Privileged roles must
 * enrol an authenticator app at first sign-in.
 */
import '../server/env.js';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { loadConfig } from '../server/config.js';
import { connect, ensureIndexes } from '../server/db.js';
import { hashPassword } from '../server/crypto.js';
import { checkRoleScope } from '../server/routes/users.js';
import { ROLES, type GeoScope, type Role } from '../shared/roles.js';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = flag('email')?.toLowerCase();
const name = flag('name');
const role = flag('role') as Role | undefined;
if (!email || !name || !role || !ROLES.includes(role)) {
  console.error(`Usage: npm run user:create -- --email <email> --name "<name>" --role <${ROLES.join('|')}> [--lga CODE[,CODE]] [--ward CODE[,CODE]]`);
  process.exit(2);
}
const scope: GeoScope = flag('lga') ? { level: 'lga', codes: flag('lga')!.split(',') } : flag('ward') ? { level: 'ward', codes: flag('ward')!.split(',') } : { level: 'state' };
const config = loadConfig();
const { client, c } = await connect(config.MONGODB_URI, config.MONGODB_DB);
await ensureIndexes(c);
try {
  await checkRoleScope(c, role, scope);
  const password = `${randomBytes(9).toString('base64url')}-7`;
  const now = new Date();
  await c.users.insertOne({ _id: new ObjectId(), email, name, role, scope, passwordHash: await hashPassword(password), mfa: { enabled: false }, status: 'active', mustChangePassword: !process.argv.includes('--no-force-change'), failedLogins: 0, createdAt: now, updatedAt: now });
  await c.audit.insertOne({ at: now, action: 'user.create', outcome: 'success', target: email, detail: { role, scope, via: 'cli' } });
  console.log(`Created ${role} ${email} in ${config.MONGODB_DB}.\nTemporary password (shown once): ${password}`);
} catch (e) {
  console.error('Could not create user:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await client.close();
}
