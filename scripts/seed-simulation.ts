/**
 * Election-day SIMULATION for the Situation Room (illustrative data, not real results).
 *
 * Creates one ward report per real ward with arrival/review times on a repeating cycle,
 * so the Situation Room looks live without any background process (works on Vercel).
 * Reports carry internal operational figures only (polling units covered, agents,
 * materials, incidents) — never vote counts.
 *
 *   npx tsx scripts/seed-simulation.ts --db lagos_eip_register          (local)
 *   npx tsx scripts/seed-simulation.ts --cloud                          (database in .env.cloud)
 */
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import { MongoClient, ObjectId } from 'mongodb';
import { DEFAULT_TEMPLATE } from '../server/routes/collation.js';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
let uri = 'mongodb://127.0.0.1:27017';
let dbName = flag('db') ?? 'lagos_eip_register';
if (args.includes('--cloud')) {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  const env = readFileSync('.env.cloud', 'utf8');
  uri = /^CLOUD_MONGODB_URI=(.*)$/m.exec(env)![1]!.trim();
  dbName = /^CLOUD_MONGODB_DB=(.*)$/m.exec(env)?.[1]?.trim() || 'lagos_eip_cloud';
}
const EXERCISE = 'SIM-ELECTION-DAY';
const CYCLE_MIN = Number(flag('cycle') ?? 60);
const FILL_MIN = Number(flag('fill') ?? 45);

let seed = 20270116;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
/** Logistic-ish arrival curve: slow start, evening surge, a tail of late wards. */
const arrival = () => {
  const u = Math.min(0.999, Math.max(0.001, rnd()));
  const x = 0.55 + 0.16 * Math.log(u / (1 - u)); // centred a little past halfway
  return Math.min(0.98, Math.max(0.02, x));
};
const INCIDENTS = [
  'Late arrival of materials at two polling units; voting extended.',
  'BVAS device delay at one polling unit, resolved by INEC staff.',
  'Minor crowd disturbance, resolved by security personnel.',
  'Party agent turned away at one polling unit; matter escalated to the ward supervisor.',
  'Rain delayed opening at one polling unit by about an hour.',
];

const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 20000 });
const db = client.db(dbName);
const wards = await db.collection('geo_units').find({ level: 'ward' }).sort({ _id: 1 }).toArray();
const aggs = new Map<string, number>((await db.collection('agg_geo').find({ level: 'ward' }, { projection: { pus: 1 } }).toArray()).map((a) => [String(a._id), a.pus as number]));
if (!wards.length) throw new Error(`No wards in ${dbName}`);

const fillSec = FILL_MIN * 60;
const now = new Date();
const docs = wards.map((w) => {
  const pus = aggs.get(String(w._id)) ?? 40;
  const never = rnd() < 0.03;
  const s = never ? null : Math.round(arrival() * fillSec);
  const reviewed = s !== null && rnd() < 0.82;
  const r = reviewed ? Math.min(CYCLE_MIN * 60 - 30, s! + 60 + Math.round(rnd() * 540)) : null;
  const f = rnd() < 0.08 ? 'returned' : 'approved';
  const incidents = rnd() < 0.18 ? 1 + Math.floor(rnd() * 3) : 0;
  const reported = Math.max(0, pus - (rnd() < 0.25 ? 1 + Math.floor(rnd() * 3) : 0));
  return {
    _id: new ObjectId(),
    exercise: EXERCISE,
    templateId: DEFAULT_TEMPLATE._id,
    ward: w._id,
    lga: w.lga,
    status: s === null ? 'draft' : r === null ? 'submitted' : f,
    values: {
      pus_total: pus,
      pus_reported: reported,
      agents_deployed: pus + Math.ceil(pus * (0.05 + rnd() * 0.15)),
      agents_absent: rnd() < 0.35 ? 1 + Math.floor(rnd() * 4) : 0,
      materials_status: rnd() < 0.86 ? 'Complete' : 'Partial',
      incidents_count: incidents,
      incident_summary: incidents ? INCIDENTS[Math.floor(rnd() * INCIDENTS.length)] : null,
      remarks: 'Simulated report — illustrative data.',
    },
    attachments: [],
    createdBy: new ObjectId(),
    createdAt: now,
    updatedAt: now,
    version: 1,
    history: [{ at: now, by: 'simulation', action: 'created', note: 'Election-day simulation' }],
    sim: { s, r, f },
  };
});

await db.collection('collation_submissions').deleteMany({ exercise: EXERCISE });
await db.collection('collation_submissions').insertMany(docs as never[]);
if (!(await db.collection('collation_templates').findOne({ _id: DEFAULT_TEMPLATE._id as never })))
  await db.collection('collation_templates').insertOne({ ...DEFAULT_TEMPLATE, updatedAt: now } as never);
await db.collection('app_settings').updateOne(
  { _id: 'collation' as never },
  { $set: { value: { exercise: EXERCISE, label: 'Election-day simulation · illustrative data, not real results' }, updatedAt: now } },
  { upsert: true },
);
await db.collection('app_settings').updateOne(
  { _id: 'simulation' as never },
  { $set: { value: { startAt: now, cycleMin: CYCLE_MIN, fillMin: FILL_MIN }, updatedAt: now } },
  { upsert: true },
);
const never = docs.filter((d) => d.sim.s === null).length;
console.log(`Simulation ready in ${dbName}: ${docs.length} ward reports (${never} never report), ${CYCLE_MIN}-minute cycle starting now.`);
await client.close();
