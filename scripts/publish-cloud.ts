/**
 * Publishes the AGGREGATE view of the verified register to a cloud MongoDB (e.g. Atlas)
 * for the online deployment. Individual voter records never leave this machine.
 *
 *   npx tsx scripts/publish-cloud.ts            (reads CLOUD_MONGODB_URI and CLOUD_MONGODB_DB from .env.cloud)
 *
 * Copied:   geographic reference, aggregates, boundaries, data-quality issues, file/job status,
 *           settings, collation templates and submissions.
 * Excluded: voter_records, ingest_rejects (record locations), users, sessions, audit_events,
 *           export_log, media_assets. Cloud users are created separately (create-user).
 */
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';

// Some ISP resolvers cannot answer the SRV lookups used by mongodb+srv:// addresses.
dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);

const env: Record<string, string> = {};
for (const line of readFileSync('.env.cloud', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const cloudUri = env.CLOUD_MONGODB_URI;
const cloudDb = env.CLOUD_MONGODB_DB || 'lagos_eip_cloud';
if (!cloudUri || !/^mongodb(\+srv)?:\/\//.test(cloudUri)) {
  console.error('Set CLOUD_MONGODB_URI in .env.cloud (mongodb+srv://...).');
  process.exit(2);
}
if (/127\.0\.0\.1|localhost/.test(cloudUri)) {
  console.error('CLOUD_MONGODB_URI points at this machine; expected a cloud cluster.');
  process.exit(2);
}

const COPY = ['geo_units', 'agg_geo', 'geo_boundaries', 'dq_issues', 'source_files', 'import_jobs', 'app_settings', 'collation_templates', 'collation_submissions'];
const NEVER = new Set(['voter_records', 'ingest_rejects', 'users', 'sessions', 'audit_events', 'export_log', 'media_assets']);

const local = await MongoClient.connect('mongodb://127.0.0.1:27017');
const cloud = await MongoClient.connect(cloudUri, { serverSelectionTimeoutMS: 20000 });
const src = local.db(process.env.SOURCE_DB ?? 'lagos_eip_register');
const dst = cloud.db(cloudDb);
const mode = (await src.collection('app_settings').findOne({ _id: 'dataset' as never }))?.value as { mode?: string } | undefined;
console.log(`Source: ${src.databaseName} (${mode?.mode ?? 'unknown'}) → cloud database "${cloudDb}"`);

for (const name of COPY) {
  if (NEVER.has(name)) throw new Error(`Refusing to copy ${name}`);
  const docs = await src.collection(name).find({}).toArray();
  const projected = name === 'source_files' ? docs.map(({ sha256: _h, ...d }) => d) : docs;
  await dst.collection(name).deleteMany({});
  for (let i = 0; i < projected.length; i += 2000) if (projected.length) await dst.collection(name).insertMany(projected.slice(i, i + 2000) as never[], { ordered: false });
  console.log(`  ${name.padEnd(22)} ${projected.length.toLocaleString()} documents`);
}
// Make sure nothing record-level exists in the cloud database.
for (const n of NEVER) if (n === 'voter_records' || n === 'ingest_rejects') await dst.collection(n).drop().catch(() => {});
await dst.collection('app_settings').updateOne(
  { _id: 'deployment' as never },
  { $set: { value: { aggregateOnly: true, publishedAt: new Date(), from: src.databaseName }, updatedAt: new Date() } },
  { upsert: true },
);
const stats = (await dst.command({ dbStats: 1 })) as { dataSize: number; indexSize: number };
console.log(`Done. Cloud database size ≈ ${((stats.dataSize + stats.indexSize) / 1048576).toFixed(1)} MB. No individual voter records were copied.`);
await local.close();
await cloud.close();
