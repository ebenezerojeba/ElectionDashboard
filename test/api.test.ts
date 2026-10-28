import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestDb, type TestDb } from './helpers/mongo.js';
import { addUser, config, H, login, makeApp, PASSWORD, seedGeography } from './helpers/fixture.js';
import { totpAt, verifyTotp, base32Decode, hotp } from '../server/auth/totp.js';
import { decrypt } from '../server/crypto.js';
import { validateValues, DEFAULT_TEMPLATE } from '../server/routes/collation.js';
import { synthVin } from './helpers/synthetic-register.js';

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let summary: Awaited<ReturnType<typeof seedGeography>>;

beforeAll(async () => {
  t = await startTestDb();
  summary = await seedGeography(t.c);
  app = makeApp(t.c);
  await addUser(t.c, 'admin@test.local', 'system_admin', { level: 'state' });
  await addUser(t.c, 'steward@test.local', 'data_steward', { level: 'state' });
  await addUser(t.c, 'exec@test.local', 'executive_viewer', { level: 'state' });
  await addUser(t.c, 'ward@test.local', 'ward_officer', { level: 'ward', codes: ['24-01-01'] });
  await addUser(t.c, 'ward2@test.local', 'ward_officer', { level: 'ward', codes: ['24-02-01'] });
  await addUser(t.c, 'lga@test.local', 'lga_officer', { level: 'lga', codes: ['24-01'] });
  await addUser(t.c, 'lga2@test.local', 'lga_officer', { level: 'lga', codes: ['24-02'] });
  await addUser(t.c, 'auditor@test.local', 'auditor', { level: 'state' });
  await addUser(t.c, 'reviewer@test.local', 'report_reviewer', { level: 'state' });
});
afterAll(async () => {
  await t.stop();
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'); // "12345678901234567890"
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
  });
  it('rejects replayed codes', () => {
    const s = 'JBSWY3DPEHPK3PXP';
    const now = Date.now();
    const step = verifyTotp(s, totpAt(s, now), now)!;
    expect(step).not.toBeNull();
    expect(verifyTotp(s, totpAt(s, now), now, step)).toBeNull();
  });
});

describe('authentication', () => {
  it('rejects bad credentials with a generic message and audits it', async () => {
    const r = await request(app).post('/api/auth/login').set(H).send({ email: 'exec@test.local', password: 'wrong-password-1' });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Incorrect email or password');
    expect(await t.c.audit.findOne({ action: 'auth.login', outcome: 'failure', target: 'exec@test.local' })).toBeTruthy();
  });

  it('blocks state-changing requests without the CSRF header', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'exec@test.local', password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('csrf');
  });

  it('locks an account after repeated failures', async () => {
    await addUser(t.c, 'lockme@test.local', 'executive_viewer', { level: 'state' });
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').set(H).send({ email: 'lockme@test.local', password: 'nope-nope-123' });
    const r = await request(app).post('/api/auth/login').set(H).send({ email: 'lockme@test.local', password: PASSWORD });
    expect(r.status).toBe(423);
  });

  it('requires MFA enrolment for privileged roles before any data access', async () => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').set(H).send({ email: 'steward@test.local', password: PASSWORD });
    expect(r.body.mfa).toBe('enroll');
    expect((await agent.get('/api/stats/overview')).body.error).toBe('mfa_required');
    const setup = await agent.post('/api/auth/mfa/setup').set(H);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await agent.post('/api/auth/mfa/confirm').set(H).send({ code: '000000' })).status).toBe(400);
    expect((await agent.post('/api/auth/mfa/confirm').set(H).send({ code: totpAt(setup.body.secret, Date.now()) })).status).toBe(200);
    expect((await agent.get('/api/stats/overview')).status).toBe(200);
    // Secret is stored encrypted, not in plaintext.
    const u = await t.c.users.findOne({ email: 'steward@test.local' });
    expect(u!.mfa.secretEnc).not.toContain(setup.body.secret);
    expect(decrypt(config.APP_ENCRYPTION_KEY, u!.mfa.secretEnc!)).toBe(setup.body.secret);
    // Next login needs a verification code.
    const again = await request.agent(app).post('/api/auth/login').set(H).send({ email: 'steward@test.local', password: PASSWORD });
    expect(again.body.mfa).toBe('verify');
  });

  it('expires sessions and stores only a hash of the session token', async () => {
    const agent = await login(app, t.c, 'exec@test.local');
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    const sessions = await t.c.sessions.find({}).toArray();
    expect(sessions.every((s) => /^[0-9a-f]{64}$/.test(s._id))).toBe(true);
    const u = await t.c.users.findOne({ email: 'exec@test.local' });
    await t.c.sessions.updateMany({ userId: u!._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('revoking a user ends their sessions immediately', async () => {
    const victim = await addUser(t.c, 'temp@test.local', 'executive_viewer', { level: 'state' });
    const agent = await login(app, t.c, 'temp@test.local');
    expect((await agent.get('/api/stats/overview')).status).toBe(200);
    const admin = await login(app, t.c, 'admin@test.local');
    const r = await admin.patch(`/api/users/${victim._id}`).set(H).send({ status: 'revoked' });
    expect(r.status).toBe(200);
    expect((await agent.get('/api/stats/overview')).status).toBe(401);
    const relogin = await request(app).post('/api/auth/login').set(H).send({ email: 'temp@test.local', password: PASSWORD });
    expect(relogin.status).toBe(401);
    expect(await t.c.audit.findOne({ action: 'user.revoke', target: 'temp@test.local' })).toBeTruthy();
  });

  it('validates role/scope combinations when creating users', async () => {
    const admin = await login(app, t.c, 'admin@test.local');
    const bad = await admin.post('/api/users').set(H).send({ email: 'x@test.local', name: 'X Person', role: 'ward_officer', scope: { level: 'state' }, password: 'Long-enough-pass-1' });
    expect(bad.status).toBe(400);
    const badCode = await admin.post('/api/users').set(H).send({ email: 'x@test.local', name: 'X Person', role: 'ward_officer', scope: { level: 'ward', codes: ['24-09-09'] }, password: 'Long-enough-pass-1' });
    expect(badCode.status).toBe(400);
    const weak = await admin.post('/api/users').set(H).send({ email: 'x@test.local', name: 'X Person', role: 'ward_officer', scope: { level: 'ward', codes: ['24-01-02'] }, password: 'short' });
    expect(weak.body.error).toBe('weak_password');
    const ok = await admin.post('/api/users').set(H).send({ email: 'x@test.local', name: 'X Person', role: 'ward_officer', scope: { level: 'ward', codes: ['24-01-02'] }, password: 'Long-enough-pass-1' });
    expect(ok.status).toBe(201);
    expect(ok.body.passwordHash).toBeUndefined();
  });
});

describe('aggregate accuracy and geographic authorisation', () => {
  it('state aggregates reconcile with the sum of LGAs and with the pipeline', async () => {
    const agent = await login(app, t.c, 'exec@test.local');
    const node = await agent.get('/api/geo/node/24');
    expect(node.status).toBe(200);
    const childSum = node.body.children.reduce((a: number, c: { records: number }) => a + c.records, 0);
    expect(node.body.unit.records).toBe(childSum);
    expect(node.body.unit.records).toBe(summary.validatedUnique);
    // 8 PUs with 11..18 voters each
    expect(summary.validatedUnique).toBe([11, 12, 13, 14, 15, 16, 17, 18].reduce((a, b) => a + b, 0));
    const ov = await agent.get('/api/stats/overview');
    expect(ov.body.metrics.validatedUnique.value).toBe(summary.validatedUnique);
    expect(ov.body.metrics.validatedUnique.definition).toMatch(/Distinct/);
    expect(ov.body.dataset.synthetic).toBe(true);
  });

  it('ward officers only see their own ward, enforced on the server', async () => {
    const agent = await login(app, t.c, 'ward@test.local');
    expect((await agent.get('/api/geo/node/24-01-01')).status).toBe(200);
    expect((await agent.get('/api/geo/node/24-01-01-001')).status).toBe(200);
    expect((await agent.get('/api/geo/node/24-01-02')).status).toBe(403);
    expect((await agent.get('/api/geo/node/24-01')).status).toBe(403);
    expect((await agent.get('/api/geo/node/24')).status).toBe(403);
    expect((await agent.get('/api/geo/table?parent=24')).status).toBe(403);
    const search = await agent.get('/api/geo/search?q=PU');
    expect(search.body.items.length).toBeGreaterThan(0);
    expect(search.body.items.every((i: { _id: string }) => i._id.startsWith('24-01-01'))).toBe(true);
    const ov = await agent.get('/api/stats/overview');
    const ward = await t.c.agg.findOne({ _id: '24-01-01' });
    expect(ov.body.metrics.validatedUnique.value).toBe(ward!.records);
    expect(await t.c.audit.findOne({ action: 'access.denied_scope', actorEmail: 'ward@test.local' })).toBeTruthy();
  });

  it('LGA officers cannot see another LGA', async () => {
    const agent = await login(app, t.c, 'lga@test.local');
    expect((await agent.get('/api/geo/node/24-01')).status).toBe(200);
    expect((await agent.get('/api/geo/node/24-02')).status).toBe(403);
    expect((await agent.get('/api/geo/node/24-02-01-001')).status).toBe(403);
  });

  it('paginates and sorts tables consistently', async () => {
    const agent = await login(app, t.c, 'exec@test.local');
    const p1 = await agent.get('/api/geo/table?parent=24&level=pu&limit=3&page=1&sort=records&dir=desc');
    const p2 = await agent.get('/api/geo/table?parent=24&level=pu&limit=3&page=2&sort=records&dir=desc');
    const p3 = await agent.get('/api/geo/table?parent=24&level=pu&limit=3&page=3&sort=records&dir=desc');
    expect(p1.body.total).toBe(8);
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items];
    expect(all).toHaveLength(8);
    expect(new Set(all.map((x: { _id: string }) => x._id)).size).toBe(8);
    const recs = all.map((x: { records: number }) => x.records);
    expect(recs).toEqual([...recs].sort((a, b) => b - a));
    const big = await agent.get('/api/geo/table?parent=24&limit=99999');
    expect(big.body.limit).toBe(500);
  });

  it('restricts individual lookups to data stewards, returns no names, and never logs the VIN', async () => {
    const exec = await login(app, t.c, 'exec@test.local');
    const vin = synthVin(100000 + 0); // first voter of seed 1 (PU 24-01-01-001)
    expect((await exec.post('/api/stats/records/lookup').set(H).send({ vin, reason: 'Testing access' })).status).toBe(403);
    const steward = await login(app, t.c, 'steward@test.local');
    const r = await steward.post('/api/stats/records/lookup').set(H).send({ vin, reason: 'Verify register entry' });
    expect(r.status).toBe(200);
    expect(r.body.matches).toHaveLength(1);
    expect(r.body.matches[0].pu).toBe('24-01-01-001');
    expect(JSON.stringify(r.body)).not.toMatch(/TEST[A-E]/);
    const log = await t.c.audit.findOne({ action: 'records.lookup', outcome: 'success' });
    expect(JSON.stringify(log)).not.toContain(vin);
  });
});

describe('collation workflow', () => {
  let subId = '';
  it('validates template values', () => {
    expect(validateValues(DEFAULT_TEMPLATE, {}, true)).toHaveProperty('pus_reported', 'Required');
    expect(validateValues(DEFAULT_TEMPLATE, { pus_total: 5, pus_reported: 6 }, false)).toHaveProperty('pus_reported');
    expect(validateValues(DEFAULT_TEMPLATE, { materials_status: 'Maybe' }, false)).toHaveProperty('materials_status');
    expect(validateValues(DEFAULT_TEMPLATE, { evil: 1 }, false)).toHaveProperty('evil', 'Unknown field');
  });

  it('ward officer drafts, cannot submit incomplete, then submits with receipt', async () => {
    const w = await login(app, t.c, 'ward@test.local');
    expect((await w.post('/api/collation/submissions').set(H).send({ ward: '24-01-02' })).status).toBe(403);
    const created = await w.post('/api/collation/submissions').set(H).send({ ward: '24-01-01' });
    expect(created.status).toBe(201);
    expect(created.body.values.pus_total).toBe(2); // prefilled from reference
    subId = created.body._id;
    const incomplete = await w.post(`/api/collation/submissions/${subId}/submit`).set(H);
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.fields).toHaveProperty('pus_reported');
    const bad = await w.patch(`/api/collation/submissions/${subId}`).set(H).send({ version: 1, values: { pus_total: 2, pus_reported: 3 } });
    expect(bad.status).toBe(400);
    const saved = await w.patch(`/api/collation/submissions/${subId}`).set(H).send({ version: 1, values: { pus_total: 2, pus_reported: 2, agents_deployed: 4, materials_status: 'Complete', incidents_count: 0 } });
    expect(saved.status).toBe(200);
    const stale = await w.patch(`/api/collation/submissions/${subId}`).set(H).send({ version: 1, values: { pus_total: 2 } });
    expect(stale.status).toBe(409);
    const sub = await w.post(`/api/collation/submissions/${subId}/submit`).set(H);
    expect(sub.status).toBe(200);
    expect(sub.body.receipt.receiptNo).toMatch(/^R-/);
    expect((await w.patch(`/api/collation/submissions/${subId}`).set(H).send({ version: 3, values: {} })).status).toBe(409);
  });

  it('ward officers cannot approve; other LGAs cannot review; own LGA can return and approve', async () => {
    const w = await login(app, t.c, 'ward@test.local');
    expect((await w.post(`/api/collation/submissions/${subId}/approve`).set(H)).status).toBe(403);
    const other = await login(app, t.c, 'lga2@test.local');
    expect((await other.post(`/api/collation/submissions/${subId}/approve`).set(H)).status).toBe(403);
    expect((await other.get(`/api/collation/submissions/${subId}`)).status).toBe(403);
    const l = await login(app, t.c, 'lga@test.local');
    expect((await l.post(`/api/collation/submissions/${subId}/return`).set(H).send({ note: 'no' })).status).toBe(400);
    expect((await l.post(`/api/collation/submissions/${subId}/return`).set(H).send({ note: 'Please recount agents' })).status).toBe(200);
    // Resubmit after correction
    const cur = (await w.get(`/api/collation/submissions/${subId}`)).body;
    expect(cur.status).toBe('returned');
    await w.patch(`/api/collation/submissions/${subId}`).set(H).send({ version: cur.version, values: { ...cur.values, agents_deployed: 5 } });
    expect((await w.post(`/api/collation/submissions/${subId}/submit`).set(H)).status).toBe(200);
    expect((await l.post(`/api/collation/submissions/${subId}/discrepancy`).set(H).send({ field: 'agents_deployed', note: 'Differs from roster by 1' })).status).toBe(200);
    expect((await l.post(`/api/collation/submissions/${subId}/approve`).set(H).send({})).status).toBe(200);
    const status = await l.get('/api/collation/lga/24-01/status');
    expect(status.body.counts).toMatchObject({ approved: 1, missing: 1 });
    expect(status.body.consolidated.approvedOnly.agents_deployed).toBe(5);
    expect((await l.get('/api/collation/lga/24-02/status')).status).toBe(403);
    const hist = (await l.get(`/api/collation/submissions/${subId}`)).body.history.map((h: { action: string }) => h.action);
    expect(hist).toEqual(['created', 'saved', 'submitted', 'returned', 'saved', 'submitted', 'discrepancy', 'approved']);
  });

  it('only accepts allowed attachment types (checked by content, not extension)', async () => {
    const w = await login(app, t.c, 'ward2@test.local');
    const s = (await w.post('/api/collation/submissions').set(H).send({ ward: '24-02-01' })).body;
    const fake = await w.post(`/api/collation/submissions/${s._id}/attachments`).set(H).attach('file', Buffer.from('MZ not a pdf'), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(400);
    const ok = await w.post(`/api/collation/submissions/${s._id}/attachments`).set(H).attach('file', Buffer.from('%PDF-1.4\n%test\n'), { filename: 'tally.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    const url = await w.get(`/api/collation/submissions/${s._id}/attachments/0`);
    expect(url.body.url).toMatch(/signed/);
  });
});

describe('report exports', () => {
  it('produces CSV, XLSX and PDF with required metadata, and audits each export', async () => {
    const agent = await login(app, t.c, 'exec@test.local');
    const csv = await agent.get('/api/reports/executive-summary?format=csv&scope=24').buffer(true);
    expect(csv.status).toBe(200);
    const text = csv.text;
    for (const k of ['Report:', 'Generated:', 'Reporting period:', 'Geographic scope:', 'Filters:', 'Source:', 'Validation status:', 'Limitations:', 'SYNTHETIC DEMONSTRATION DATA']) expect(text).toContain(k);
    expect(text).toContain(String(summary.validatedUnique));
    const xlsx = await agent.get('/api/reports/geo-aggregate?format=xlsx&scope=24-01').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xlsx.status).toBe(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const pdf = await agent.get('/api/reports/data-quality?format=pdf&scope=24').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(await t.c.exports.countDocuments({ status: 'generated' })).toBeGreaterThanOrEqual(3);
    expect(await t.c.audit.countDocuments({ action: 'report.export', outcome: 'success' })).toBeGreaterThanOrEqual(3);
  });

  it('denies exports without permission or outside scope', async () => {
    const w = await login(app, t.c, 'ward@test.local');
    const r = await w.get('/api/reports/executive-summary?format=csv&scope=24-01-01');
    expect(r.status).toBe(403);
    expect(await t.c.exports.findOne({ status: 'denied', userEmail: 'ward@test.local' })).toBeTruthy();
    const l = await login(app, t.c, 'lga@test.local');
    expect((await l.get('/api/reports/geo-aggregate?format=csv&scope=24-02')).status).toBe(403);
    expect((await l.get('/api/reports/geo-aggregate?format=csv&scope=24-01')).status).toBe(200);
    expect((await l.get('/api/reports/import-jobs?format=csv')).status).toBe(403);
    expect((await l.get('/api/reports/geo-aggregate?format=exe&scope=24-01')).status).toBe(400);
  });

  it('neutralises spreadsheet formula injection in CSV', async () => {
    await t.c.geo.updateOne({ _id: '24-01' }, { $set: { name: '=HYPERLINK("x")' } });
    await t.c.agg.updateOne({ _id: '24-01' }, { $set: { name: '=HYPERLINK("x")' } });
    const agent = await login(app, t.c, 'exec@test.local');
    const csv = await agent.get('/api/reports/executive-summary?format=csv&scope=24').buffer(true);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    await t.c.agg.updateOne({ _id: '24-01' }, { $set: { name: 'LGA 01' } });
  });
});

describe('audit log and error handling', () => {
  it('only auditors/admins can read the audit log', async () => {
    expect((await (await login(app, t.c, 'exec@test.local')).get('/api/stats/audit')).status).toBe(403);
    const a = await login(app, t.c, 'auditor@test.local');
    const r = await a.get('/api/stats/audit?action=auth.&limit=5');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(5);
    expect(r.body.items.every((i: { action: string }) => i.action.startsWith('auth.'))).toBe(true);
  });

  it('returns clean JSON errors without internal details', async () => {
    const agent = await login(app, t.c, 'exec@test.local');
    expect((await agent.get('/api/nope')).status).toBe(404);
    expect((await agent.get('/api/geo/node/not-a-code')).status).toBe(400);
    const big = await agent.post('/api/auth/password').set(H).set('content-type', 'application/json').send(JSON.stringify({ current: 'x'.repeat(300_000), next: 'y' }));
    expect(big.status).toBe(413);
    expect((await request(app).get('/api/stats/overview')).status).toBe(401);
  });
});

describe('leadership insights', () => {
  it('field operations plan reconciles with aggregates and respects assumptions', async () => {
    const agent = await login(app, t.c, 'exec@test.local');
    const r = await agent.get('/api/insights/plan?scope=24&threshold=100&extraPer=5&wardAgents=2&lgaSupervisors=3');
    expect(r.status).toBe(200);
    expect(r.body.totals.voters).toBe(summary.validatedUnique);
    expect(r.body.totals.pus).toBe(8);
    expect(r.body.totals.wards).toBe(4);
    expect(r.body.totals.collationAgents).toBe(8); // 4 wards x 2
    expect(r.body.totals.supervisors).toBe(6); // 2 LGAs x 3
    expect(r.body.rows.reduce((a: number, x: { voters: number }) => a + x.voters, 0)).toBe(r.body.totals.voters);
    const bad = await agent.get('/api/insights/plan?scope=24&threshold=-5');
    expect(bad.body.assumptions.threshold).toBe(750); // invalid input falls back to default
  });

  it('insights are scoped on the server', async () => {
    const l = await login(app, t.c, 'lga@test.local');
    expect((await l.get('/api/insights/plan?scope=24-01')).status).toBe(200);
    expect((await l.get('/api/insights/plan?scope=24')).status).toBe(403);
    expect((await l.get('/api/insights/plan?scope=24-02')).status).toBe(403);
    const w = await login(app, t.c, 'ward@test.local');
    expect((await w.get('/api/insights/audit?scope=24-01-01')).status).toBe(403); // ward officers lack quality.read
    const sit = await l.get('/api/insights/situation');
    expect(sit.status).toBe(200);
    expect(sit.body.lgas.map((x: { code: string }) => x.code)).toEqual(['24-01']);
  });

  it('register audit and executive brief export', async () => {
    const s = await login(app, t.c, 'steward@test.local');
    const a = await s.get('/api/insights/audit?scope=24');
    expect(a.status).toBe(200);
    expect(a.body.rows).toHaveLength(2);
    const e = await login(app, t.c, 'exec@test.local');
    const pdf = await e.get('/api/reports/executive-brief?format=pdf&scope=24').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const csv = await e.get('/api/reports/ops-plan?format=csv&scope=24').buffer(true);
    expect(csv.text).toContain('Field Operations Deployment Sheet');
    expect(csv.text).toContain('TOTAL');
  });
});

describe('audit fixes', () => {
  it('login rate limit persists across requests (per account)', async () => {
    const { createApp } = await import('../server/app.js');
    const strict = createApp({ c: t.c, config: { ...config, RATE_LIMIT_LOGIN_PER_15MIN: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await request(strict).post('/api/auth/login').set(H).send({ email: 'nobody@test.local', password: 'wrong-wrong-1' })).status);
    expect(codes).toEqual([401, 401, 429, 429]);
  });

  it('admin-issued temporary passwords must be changed before using the app', async () => {
    const admin = await login(app, t.c, 'admin@test.local');
    const created = await admin.post('/api/users').set(H).send({ email: 'newbie@test.local', name: 'New Person', role: 'executive_viewer', scope: { level: 'state' }, password: PASSWORD });
    expect(created.status).toBe(201);
    expect(created.body.mustChangePassword).toBe(true);
    const u = request.agent(app);
    await u.post('/api/auth/login').set(H).send({ email: 'newbie@test.local', password: PASSWORD });
    const blocked = await u.get('/api/stats/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('password_change_required');
    expect((await u.post('/api/auth/password').set(H).send({ current: PASSWORD, next: 'Brand-new-secret-9' })).status).toBe(200);
    expect((await u.get('/api/stats/overview')).status).toBe(200);
  });

  it('rejects malformed JSON with 400', async () => {
    const r = await request(app).post('/api/auth/login').set(H).set('content-type', 'application/json').send('{bad json');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_json');
  });

  it('high-confidence audit total excludes low-confidence name matches', async () => {
    const s = await login(app, t.c, 'steward@test.local');
    const a = await s.get('/api/insights/audit?scope=24');
    for (const r of a.body.rows) expect(r.total).toBe(r.dupVin + r.badBirthYear + r.rejected + r.countMismatch);
  });
});
