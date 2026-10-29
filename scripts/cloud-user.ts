/**
 * Creates a user in the CLOUD database (reads .env.cloud). Same flags as create-user.
 *   npx tsx scripts/cloud-user.ts --email x@y --name "Name" --role executive_viewer
 */
import { readFileSync } from 'node:fs';
import dns from 'node:dns';

dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]); // SRV lookups for mongodb+srv
const env = Object.fromEntries(
  readFileSync('.env.cloud', 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, '')]),
);
if (!env.CLOUD_MONGODB_URI) throw new Error('CLOUD_MONGODB_URI missing in .env.cloud');
// Set before the user script loads; existing variables are not overwritten by the local .env loader.
process.env.MONGODB_URI = env.CLOUD_MONGODB_URI;
process.env.MONGODB_DB = env.CLOUD_MONGODB_DB || 'lagos_eip_cloud';
await import('./create-user.js');
