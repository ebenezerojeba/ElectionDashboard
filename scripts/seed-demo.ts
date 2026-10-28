/**
 * Builds the SYNTHETIC demonstration environment.
 *
 *   npm run seed:demo            (uses MONGODB_DB, default lagos_eip_demo; refuses a register database)
 *
 * - LGA names are the 20 public Lagos LGA names; wards, polling units, voters and every figure
 *   are generated. The dataset is labelled "synthetic" and every page/report shows a banner.
 * - Data goes through the real import pipeline (parser, validation, reconciliation, DQ rules).
 * - Deliberate defects are injected so data-quality features have something to show.
 * - Demo user credentials are written to .demo-credentials.txt (git-ignored).
 */
import '../server/env.js';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { loadConfig } from '../server/config.js';
import { connect, ensureIndexes, type SubmissionDoc, type UserDoc } from '../server/db.js';
import { encrypt, hashPassword } from '../server/crypto.js';
import { generateSecret } from '../server/auth/totp.js';
import { fileKeyOf, type CatalogEntry } from '../worker/catalog.js';
import { createJob, runJob, syncCatalog } from '../worker/ingest.js';
import { verifyAndAggregate } from '../worker/verify.js';
import { DEFAULT_TEMPLATE } from '../server/routes/collation.js';
import type { GeoScope, Role } from '../shared/roles.js';

const config = loadConfig();
if (/register/i.test(config.MONGODB_DB)) {
  console.error(`Refusing to seed synthetic data into "${config.MONGODB_DB}".`);
  process.exit(2);
}
const { client, c, db } = await connect(config.MONGODB_URI, config.MONGODB_DB);
const existing = (await c.settings.findOne({ _id: 'dataset' }))?.value as { mode?: string } | undefined;
if (existing?.mode === 'register') {
  console.error('This database contains register data. Use a separate database for the demo.');
  process.exit(2);
}
console.log(`Seeding synthetic demo into "${config.MONGODB_DB}"…`);
await db.dropDatabase();
await ensureIndexes(c);

// ---------- deterministic pseudo-random ----------
let s = 20260926;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;

const LGAS = ['AGEGE', 'AJEROMI-IFELODUN', 'ALIMOSHO', 'AMUWO-ODOFIN', 'APAPA', 'BADAGRY', 'EPE', 'ETI-OSA', 'IBEJU-LEKKI', 'IFAKO-IJAIYE', 'IKEJA', 'IKORODU', 'KOSOFE', 'LAGOS ISLAND', 'LAGOS MAINLAND', 'MUSHIN', 'OJO', 'OSHODI-ISOLO', 'SHOMOLU', 'SURULERE'];
const SURN = ['DEMO', 'SAMPLE', 'TESTER', 'EXAMPLE', 'MOCK', 'PLACEHOLDER', 'FICTIVE', 'SYNTH'];
const OTHER = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO', 'UNIFORM', 'VICTOR', 'WHISKEY', 'XRAY', 'YANKEE', 'ZULU'];
// Syllables make surnames varied enough that the duplicate-name rule behaves realistically (all names are obviously fictitious).
const SYL = ['BA', 'DO', 'FE', 'GI', 'KO', 'LA', 'MU', 'NE', 'PO', 'RI', 'SA', 'TU', 'WE', 'YO', 'ZA', 'BE', 'DI', 'FO', 'GU', 'KA'];

interface Voter { name: string; vin: string; by: number | string; g: string }
interface DemoFile { entry: CatalogEntry; voters: Voter[]; code: string; lgaName: string; wardName: string; puName: string; alpha: boolean; broken?: boolean; coverDelta?: number }

let vinSeq = 0;
const newVin = () => `DM${String(++vinSeq).padStart(17, '0')}`; // 19 chars, obviously synthetic
const files: DemoFile[] = [];
let sharedVin: Voter | null = null;

LGAS.forEach((lgaName, li) => {
  const l = String(li + 1).padStart(2, '0');
  const wards = int(3, 5);
  for (let w = 1; w <= wards; w++) {
    const wc = String(w).padStart(2, '0');
    const wardName = `DEMO WARD ${l}-${wc}`;
    const pus = int(4, 7);
    for (let p = 1; p <= pus; p++) {
      const pc = String(p).padStart(3, '0');
      const code = `24-${l}-${wc}-${pc}`;
      const puName = `DEMO POLLING UNIT ${pc}`;
      const n = int(120, 520);
      const voters: Voter[] = Array.from({ length: n }, () => ({
        name: `${pick(SURN)}${pick(SYL)}${pick(SYL)}, ${pick(OTHER)} ${pick(OTHER)}`,
        vin: newVin(),
        by: 2026 - (18 + Math.floor(rnd() ** 1.7 * 72)), // skewed towards younger voters
        g: rnd() < 0.52 ? 'M' : 'F',
      }));
      // Injected defects (deterministic positions)
      if (li === 2 && w === 1 && p === 1) voters[3]!.vin = 'BAD'; // malformed VIN -> rejected row
      if (li === 4 && w === 2 && p === 2) voters[5]!.by = 2019; // implausible birth year
      if (li === 7 && w === 1 && p === 1) sharedVin = voters[0]!;
      if (li === 7 && w === 1 && p === 2 && sharedVin) voters.push({ ...sharedVin }); // duplicate VIN across PUs
      if (li === 10 && w === 1 && p === 3) voters.push({ ...voters[0]!, vin: newVin() }); // same name+birth year, new VIN
      const alphaOnly = li % 5 === 1 && p === 1; // only the alphabetical copy exists -> gender unavailable
      const both = p === 2 && w === 1; // both copies exist
      const relBase = `${l}_${lgaName.replace(/\W+/g, '_')}/${wc}_${wardName.replace(/\W+/g, '_')}/${pc}_${puName.replace(/\W+/g, '_')}`;
      const mk = (alpha: boolean, extra: Partial<DemoFile> = {}): DemoFile => {
        const relPath = alpha ? `${relBase}_A-Z_group_A-Z_1_of_1.pdf` : `${relBase}_group_1_of_1.pdf`;
        return {
          entry: { fileKey: fileKeyOf(relPath), relPath, size: 1000 + n * 1700, mtimeMs: 1, lgaFolderNo: l, lgaFolderName: lgaName, wardFolderNo: wc, wardFolderName: wardName, puFolderNo: pc, puFileName: puName, variant: alpha ? 'alpha' : 'default', letterRange: alpha ? 'A-Z' : null, part: 1, partOf: 1, impliedPuCode: code },
          voters, code, lgaName, wardName, puName, alpha, ...extra,
        };
      };
      if (alphaOnly) files.push(mk(true));
      else files.push(mk(false, li === 12 && w === 2 && p === 3 ? { broken: true } : li === 15 && w === 1 && p === 4 ? { coverDelta: 2 } : {}));
      if (both) files.push(mk(true));
    }
  }
});

function pagesFor(f: DemoFile): string[][] {
  const voters = f.alpha ? [...f.voters].sort((a, b) => a.name.localeCompare(b.name)).map((v) => ({ ...v, g: 'M' })) : f.voters;
  const per = 34;
  const nPages = Math.ceil(voters.length / per);
  const pages: string[][] = [[
    'FEDERAL REPUBLIC OF NIGERIA', f.alpha ? 'Valid Registrations: (A-Z)' : 'Valid Registrations', 'State LAGOS', `LGA ${f.lgaName}`, `Ward ${f.wardName}`, `PU ${f.puName}`,
    `Delim ${f.code}`, 'Printed 29-09-2026', `Records ${voters.length + (f.coverDelta ?? 0)}`, `Pages ${nPages}`,
  ]];
  for (let p = 0; p < nPages; p++) {
    const L = ['FEDERAL REPUBLIC OF NIGERIA', 'Valid Registrations: (A-Z)', 'State: LAGOS', `Local Govt. Area: ${f.lgaName}`, `Registration Area: ${f.wardName}`, `PU: ${f.puName}`, 'Time Printed: 29-09-2026', `Total Records: ${voters.length}`, `Page: ${p + 1} of ${nPages}`];
    voters.slice(p * per, (p + 1) * per).forEach((v, i) => {
      L.push(String(p * per + i + 1), v.name, `VIN: ${v.vin}`, `DOB-Y: ${v.by} | Gender: ${v.g}`, `PAGE ${p + 1} of ${nPages}`, `Valid Registrations: (A-Z) | DELIM: ${f.code} | 29-09-2026`);
    });
    pages.push(L);
  }
  return pages;
}

const byPath = new Map(files.map((f) => [f.entry.relPath, f]));
const deps = {
  c,
  hashKey: config.RECORD_HASH_KEY,
  sourceRoot: '/synthetic-demo',
  memoryLimitMb: 2000,
  batchSize: 1000,
  readSource: async (abs: string) => new TextEncoder().encode(abs.replace(/\\/g, '/').replace(/^.*?synthetic-demo\//, '')),
  extract: async (d: Uint8Array) => {
    const f = byPath.get(new TextDecoder().decode(d))!;
    if (f.broken) throw new Error('Invalid PDF structure (synthetic defect)');
    const pages = pagesFor(f);
    return { pageCount: pages.length, pages, pageErrors: [] };
  },
  log: (m: string, d?: Record<string, unknown>) => console.log(`  ${m}${d ? ' ' + JSON.stringify(d) : ''}`),
};
await c.settings.updateOne({ _id: 'dataset' }, { $set: { value: { mode: 'synthetic', label: 'SYNTHETIC DEMONSTRATION DATA — not official statistics' }, updatedAt: new Date() } }, { upsert: true });
await syncCatalog(deps, { entries: files.map((f) => f.entry), unrecognised: [] });
console.log(`Importing ${files.length} synthetic register files through the pipeline…`);
// Pilot first (one LGA), then the rest — mirrors the real procedure.
await runJob(deps, (await createJob(deps, { pathPrefix: '01_', createdBy: 'seed-demo (pilot)' }))._id);
await runJob(deps, (await createJob(deps, { createdBy: 'seed-demo' }))._id);
const summary = await verifyAndAggregate(c, { by: 'seed-demo' });
console.log(`  validated unique records: ${summary.validatedUnique}; balanced PUs: ${summary.reconciliation.pusBalanced}; unbalanced: ${summary.reconciliation.pusUnbalanced}`);

// ---------- Users ----------
const creds: string[] = ['SYNTHETIC DEMO CREDENTIALS — local use only. Delete this file after the demonstration.', ''];
const now = new Date();
async function user(email: string, name: string, role: Role, scope: GeoScope, mfa = false) {
  const password = `Demo-${randomBytes(6).toString('base64url')}-1`;
  const secret = mfa ? generateSecret() : undefined;
  const u: UserDoc = {
    _id: new ObjectId(), email, name, role, scope, passwordHash: await hashPassword(password),
    mfa: secret ? { enabled: true, secretEnc: encrypt(config.APP_ENCRYPTION_KEY, secret) } : { enabled: false },
    status: 'active', failedLogins: 0, createdAt: now, updatedAt: now,
  };
  await c.users.insertOne(u);
  creds.push(`${role.padEnd(18)} ${email.padEnd(32)} ${password}${secret ? `   TOTP secret: ${secret}` : ''}`);
  return u;
}
const admin = await user('admin@demo.local', 'Demo Administrator', 'system_admin', { level: 'state' }, true);
await user('steward@demo.local', 'Demo Data Steward', 'data_steward', { level: 'state' }, true);
await user('executive@demo.local', 'Demo Executive', 'executive_viewer', { level: 'state' });
await user('reviewer@demo.local', 'Demo Report Reviewer', 'report_reviewer', { level: 'state' }, true);
await user('auditor@demo.local', 'Demo Auditor', 'auditor', { level: 'state' }, true);
const lgaOfficer = await user('lga.ikeja@demo.local', 'Demo LGA Officer (Ikeja)', 'lga_officer', { level: 'lga', codes: ['24-11'] });
const ikejaWards = await c.geo.find({ level: 'ward', lga: '24-11' }).sort({ _id: 1 }).toArray();
const wardOfficers: UserDoc[] = [];
for (const w of ikejaWards) wardOfficers.push(await user(`ward.${w._id}@demo.local`, `Demo Ward Officer ${w._id}`, 'ward_officer', { level: 'ward', codes: [w._id] }));

// ---------- Collation (Ikeja: mix of statuses; one ward missing) ----------
await c.templates.insertOne({ ...DEFAULT_TEMPLATE, updatedAt: now });
await c.settings.updateOne({ _id: 'collation' }, { $set: { value: { exercise: 'DEMO-2026', label: 'Synthetic dry-run exercise (DEMO-2026)' }, updatedAt: now } }, { upsert: true });
const statuses: SubmissionDoc['status'][] = ['approved', 'submitted', 'returned', 'draft'];
for (let i = 0; i < ikejaWards.length - 1; i++) {
  const w = ikejaWards[i]!;
  const status = statuses[i % statuses.length]!;
  const agg = await c.agg.findOne({ _id: w._id });
  const by = wardOfficers[i]!;
  const t0 = new Date(now.getTime() - (10 - i) * 3_600_000);
  const history: SubmissionDoc['history'] = [{ at: t0, by: by.email, action: 'created' }, { at: t0, by: by.email, action: 'saved' }];
  if (status !== 'draft') history.push({ at: new Date(t0.getTime() + 600_000), by: by.email, action: 'submitted' });
  if (status === 'returned') history.push({ at: new Date(t0.getTime() + 1_800_000), by: lgaOfficer.email, action: 'returned', note: 'Agents figure differs from deployment roster' });
  if (status === 'approved') history.push({ at: new Date(t0.getTime() + 1_800_000), by: lgaOfficer.email, action: 'approved' });
  await c.submissions.insertOne({
    _id: new ObjectId(), exercise: 'DEMO-2026', templateId: DEFAULT_TEMPLATE._id, ward: w._id, lga: '24-11', status,
    values: { pus_total: agg?.pus ?? 0, pus_reported: Math.max(0, (agg?.pus ?? 0) - (i % 2)), agents_deployed: 8 + i, agents_absent: i % 3, materials_status: i % 3 === 2 ? 'Partial' : 'Complete', incidents_count: i % 2, incident_summary: i % 2 ? 'Synthetic incident note for demonstration.' : null, remarks: null },
    attachments: [], receiptNo: status === 'draft' ? undefined : `R-DEMO-2026-${w._id}-00${i}`, createdBy: by._id, createdAt: t0, updatedAt: history[history.length - 1]!.at,
    submittedAt: status === 'draft' ? undefined : new Date(t0.getTime() + 600_000), version: history.length, history,
    discrepancies: status === 'returned' ? [{ field: 'agents_deployed', note: 'Differs from roster by 2', at: new Date(t0.getTime() + 1_700_000), by: lgaOfficer.email }] : [],
  });
  for (const h of history) await c.audit.insertOne({ at: h.at, actorEmail: h.by, actorRole: h.by === lgaOfficer.email ? 'lga_officer' : 'ward_officer', action: `collation.${h.action === 'returned' ? 'return' : h.action === 'approved' ? 'approve' : h.action === 'submitted' ? 'submit' : h.action === 'created' ? 'create' : 'save'}`, outcome: 'success', target: w._id });
}
await c.audit.insertOne({ at: now, actorId: admin._id, actorEmail: admin.email, actorRole: 'system_admin', action: 'demo.seeded', outcome: 'success', detail: { records: summary.validatedUnique } });

writeFileSync('.demo-credentials.txt', creds.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
console.log(`Done. ${creds.length - 2} demo users created; credentials written to .demo-credentials.txt (git-ignored).`);
await client.close();
