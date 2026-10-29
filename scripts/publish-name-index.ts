/**
 * Publishes the compact name-fingerprint index (see server/services/nameIndex.ts) to the cloud
 * database so the online "Check registration" page works. No names or VINs are uploaded.
 *
 *   npx tsx scripts/publish-name-index.ts          (reads .env.cloud; source = local lagos_eip_register)
 *
 * The online server must use the SAME RECORD_HASH_KEY as the office machine for checks to match.
 */
import '../server/env.js';
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';
import { buildNameIndex } from '../server/services/nameIndex.js';
import type { VoterRecordDoc } from '../server/db.js';

dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
const env = readFileSync('.env.cloud', 'utf8');
const cloudUri = /^CLOUD_MONGODB_URI=(.*)$/m.exec(env)![1]!.trim();
const cloudDb = /^CLOUD_MONGODB_DB=(.*)$/m.exec(env)?.[1]?.trim() || 'lagos_eip_cloud';

const local = await MongoClient.connect('mongodb://127.0.0.1:27017');
const cloud = await MongoClient.connect(cloudUri, { serverSelectionTimeoutMS: 30000 });
const records = local.db('lagos_eip_register').collection<VoterRecordDoc>('voter_records');
const target = cloud.db(cloudDb).collection<{ _id: string }>('name_index');
await target.deleteMany({});
const t0 = Date.now();
const r = await buildNameIndex(
  records,
  async (docs) => {
    await target.insertMany(docs as never[], { ordered: false });
  },
  (m) => console.log(m),
);
const stats = (await cloud.db(cloudDb).command({ dbStats: 1 })) as { dataSize: number; indexSize: number };
console.log(`Done in ${Math.round((Date.now() - t0) / 1000)} s: ${r.entries.toLocaleString()} fingerprints, ${r.buckets} buckets, ${r.pus} polling units. Cloud database now ≈ ${((stats.dataSize + stats.indexSize) / 1048576).toFixed(0)} MB.`);
await local.close();
await cloud.close();
