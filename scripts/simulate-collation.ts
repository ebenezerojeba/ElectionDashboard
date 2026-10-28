/**
 * LIVE PITCH SIMULATOR — synthetic demo database only.
 * Feeds synthetic ward reports into the active exercise so the Situation Room fills up live.
 *
 *   npm run simulate                       (defaults: reset, prefill 25%, one event every 3 s)
 *   npm run simulate -- --interval 2 --prefill 10 --no-reset
 *
 * Refuses to run unless the database is marked as synthetic.
 */
import '../server/env.js';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { loadConfig } from '../server/config.js';
import { connect, type SubmissionDoc } from '../server/db.js';
import { DEFAULT_TEMPLATE } from '../server/routes/collation.js';

const args = process.argv.slice(2);
const flag = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const intervalMs = Math.max(0.5, flag('interval', 3)) * 1000;
const prefill = Math.min(100, Math.max(0, flag('prefill', 25)));
const reset = !args.includes('--no-reset');

const config = loadConfig();
const { client, c } = await connect(config.MONGODB_URI, config.MONGODB_DB);
const mode = (await c.settings.findOne({ _id: 'dataset' }))?.value as { mode?: string } | undefined;
if (mode?.mode !== 'synthetic') {
  console.error(`Refusing: "${config.MONGODB_DB}" is not a synthetic demo database.`);
  process.exit(2);
}
const ex = ((await c.settings.findOne({ _id: 'collation' }))?.value as { exercise?: string } | undefined)?.exercise ?? 'DEMO-2026';
const wards = await c.geo.find({ level: 'ward' }).toArray();
const officers = new Map((await c.users.find({ role: 'ward_officer' }).toArray()).map((u) => [u.scope.level === 'ward' ? u.scope.codes[0] : '', u]));
const reviewer = await c.users.findOne({ role: 'lga_officer' });
let s = Date.now() % 2147483647;
const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;

if (reset) {
  const r = await c.submissions.deleteMany({ exercise: ex, lga: { $ne: '24-11' } });
  console.log(`Reset: cleared ${r.deletedCount} simulated reports (Ikeja examples kept).`);
}

async function submitWard(wardCode: string, at: Date) {
  const w = wards.find((x) => x._id === wardCode)!;
  const agg = await c.agg.findOne({ _id: wardCode }, { projection: { pus: 1 } });
  const pus = agg?.pus ?? 5;
  const by = officers.get(wardCode)?.email ?? `ward.${wardCode}@demo.local`;
  const incidents = rnd() < 0.15 ? 1 + Math.floor(rnd() * 3) : 0;
  const doc: SubmissionDoc = {
    _id: new ObjectId(), exercise: ex, templateId: DEFAULT_TEMPLATE._id, ward: wardCode, lga: w.lga!, status: 'submitted',
    values: {
      pus_total: pus, pus_reported: Math.max(0, pus - (rnd() < 0.2 ? 1 : 0)), agents_deployed: pus + Math.floor(rnd() * 3), agents_absent: rnd() < 0.3 ? 1 : 0,
      materials_status: rnd() < 0.85 ? 'Complete' : 'Partial', incidents_count: incidents, incident_summary: incidents ? 'Synthetic incident note (demo).' : null, remarks: null,
    },
    attachments: [], receiptNo: `R-${ex}-${wardCode}-001-${randomBytes(3).toString('hex').toUpperCase()}`, createdBy: officers.get(wardCode)?._id ?? new ObjectId(),
    createdAt: at, updatedAt: at, submittedAt: at, version: 3, history: [{ at, by, action: 'created' }, { at, by, action: 'submitted' }],
  };
  await c.submissions.updateOne({ exercise: ex, ward: wardCode, templateId: DEFAULT_TEMPLATE._id }, { $setOnInsert: doc }, { upsert: true });
  await c.audit.insertOne({ at, actorEmail: by, actorRole: 'ward_officer', action: 'collation.submit', outcome: 'success', target: wardCode, detail: { simulated: true } });
}
async function review(sub: { _id: ObjectId; ward: string }, action: 'approve' | 'return', at: Date) {
  const status = action === 'approve' ? 'approved' : 'returned';
  await c.submissions.updateOne({ _id: sub._id, status: 'submitted' }, { $set: { status, reviewedAt: at, updatedAt: at }, $inc: { version: 1 }, $push: { history: { at, by: reviewer?.email ?? 'lga@demo.local', action: status, ...(action === 'return' ? { note: 'Please confirm agents count (simulated)' } : {}) } } });
  await c.audit.insertOne({ at, actorEmail: reviewer?.email ?? 'lga@demo.local', actorRole: 'lga_officer', action: `collation.${action}`, outcome: 'success', target: sub.ward, detail: { simulated: true } });
}

const reported = async () => new Set((await c.submissions.find({ exercise: ex }).project<{ ward: string }>({ ward: 1 }).toArray()).map((x) => x.ward));
// Prefill a share of wards (backdated) so the screen does not start empty.
let done = await reported();
const pending = wards.filter((w) => !done.has(w._id));
const nPre = Math.floor((pending.length * prefill) / 100);
for (let i = 0; i < nPre; i++) {
  const w = pending.splice(Math.floor(rnd() * pending.length), 1)[0]!;
  await submitWard(w._id, new Date(Date.now() - (nPre - i) * 20_000));
}
console.log(`Prefilled ${nPre} wards. Simulating one event every ${intervalMs / 1000}s — Ctrl+C to stop.`);

let stop = false;
process.on('SIGINT', () => (stop = true));
while (!stop) {
  const now = new Date();
  const r = rnd();
  const submitted = await c.submissions.find({ exercise: ex, status: 'submitted' }).project<{ _id: ObjectId; ward: string }>({ ward: 1 }).toArray();
  done = await reported();
  const left = wards.filter((w) => !done.has(w._id));
  if (left.length && (r < 0.6 || !submitted.length)) {
    const w = pick(left);
    await submitWard(w._id, now);
    console.log(`${now.toLocaleTimeString()}  submitted  ${w._id} ${w.name}  (${wards.length - left.length + 1}/${wards.length})`);
  } else if (submitted.length) {
    const sub = pick(submitted);
    const act = rnd() < 0.88 ? 'approve' : 'return';
    await review(sub, act, now);
    console.log(`${now.toLocaleTimeString()}  ${act === 'approve' ? 'approved ' : 'returned '}  ${sub.ward}`);
  } else {
    console.log('All wards reported and reviewed.');
    break;
  }
  await new Promise((res) => setTimeout(res, intervalMs));
}
await client.close();
