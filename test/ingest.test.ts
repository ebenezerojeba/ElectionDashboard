import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../worker/catalog.js';
import { fileKeyOf } from '../worker/catalog.js';
import { createJob, runJob, syncCatalog, type IngestDeps } from '../worker/ingest.js';
import { verifyAndAggregate } from '../worker/verify.js';
import { recordIdOf } from '../server/crypto.js';
import { startTestDb, type TestDb } from './helpers/mongo.js';
import { synthDocument, synthVoters, type SynthVoter } from './helpers/synthetic-register.js';

const KEY = 'ab'.repeat(32);
let t: TestDb;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

interface FakeFile {
  relPath: string;
  code: string;
  voters: SynthVoter[];
  variant: 'alpha' | 'default';
  coverRecords?: number;
  broken?: boolean;
}

function entry(f: FakeFile): CatalogEntry {
  const [lgaDir, wardDir, name] = f.relPath.split('/');
  return {
    fileKey: fileKeyOf(f.relPath),
    relPath: f.relPath,
    size: 1000 + f.voters.length,
    mtimeMs: 1,
    lgaFolderNo: lgaDir!.slice(0, 2),
    lgaFolderName: lgaDir!.slice(3),
    wardFolderNo: wardDir!.slice(0, 2),
    wardFolderName: wardDir!.slice(3),
    puFolderNo: name!.slice(0, 3),
    puFileName: 'SYNTH PU',
    variant: f.variant,
    letterRange: f.variant === 'alpha' ? 'A-Z' : null,
    part: 1,
    partOf: 1,
    impliedPuCode: f.code,
  };
}

/** Builds ingest deps over in-memory synthetic files; the "PDF bytes" are just the relPath. */
function setup(files: FakeFile[], over: Partial<IngestDeps> = {}) {
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const deps: IngestDeps = {
    c: t.c,
    hashKey: KEY,
    sourceRoot: '/synthetic',
    memoryLimitMb: 10_000,
    batchSize: 7, // small batches exercise multi-batch writes
    readSource: async (abs) => new TextEncoder().encode(abs.replace(/\\/g, '/').replace(/^.*?synthetic\//, '')),
    extract: async (data) => {
      const f = byPath.get(new TextDecoder().decode(data))!;
      if (f.broken) throw new Error('Invalid PDF structure');
      let voters = f.voters;
      if (f.variant === 'alpha') voters = [...voters].sort((a, b) => a.surname.localeCompare(b.surname)).map((v) => ({ ...v, gender: 'M' })); // source defect reproduced
      const pages = synthDocument(voters, { code: f.code, alpha: f.variant === 'alpha', coverRecords: f.coverRecords });
      return { pageCount: pages.length, pages, pageErrors: [] };
    },
    ...over,
  };
  return { deps, sync: () => syncCatalog(deps, { entries: files.map(entry), unrecognised: [] }) };
}

const P1 = '01_LGA_ONE/01_WARD_A/001_X_group_1_of_1.pdf';
const P1A = '01_LGA_ONE/01_WARD_A/001_X_A-Z_group_A-Z_1_of_1.pdf';
const P2 = '01_LGA_ONE/01_WARD_A/002_Y_group_1_of_1.pdf';
const P3A = '01_LGA_ONE/02_WARD_B/001_Z_A-Z_group_A-Z_1_of_1.pdf';

describe('ingestion pipeline', () => {
  it('imports, reconciles and aggregates correctly', async () => {
    const v1 = synthVoters(23, 1);
    const v2 = synthVoters(11, 2);
    const { deps, sync } = setup([
      { relPath: P1, code: '24-01-01-001', voters: v1, variant: 'default' },
      { relPath: P2, code: '24-01-01-002', voters: v2, variant: 'default' },
    ]);
    await sync();
    const job = await createJob(deps, {});
    const r = await runJob(deps, job._id);
    expect(r).toMatchObject({ status: 'completed', filesProcessed: 2 });
    const s = await verifyAndAggregate(t.c, { by: 'test', referenceYear: 2026 });
    expect(s.validatedUnique).toBe(34);
    expect(s.reconciliation).toMatchObject({ pusBalanced: 2, pusUnbalanced: 0 });
    const ward = await t.c.agg.findOne({ _id: '24-01-01' });
    const females = [...v1, ...v2].filter((v) => v.gender === 'F').length;
    expect(ward).toMatchObject({ records: 34, female: females, male: 34 - females, expected: 34, pus: 2 });
    const state = await t.c.agg.findOne({ _id: '24' });
    expect(state!.records).toBe(34);
    expect(Object.values(state!.ageBands).reduce((a, b) => a + b, 0)).toBe(34);
    // No personal values are stored.
    const rec = await t.c.records.findOne({});
    expect(JSON.stringify(rec)).not.toMatch(/TEST[A-E]|SYN0/);
  });

  it('loads both copies of a polling unit without duplicating, taking gender only from the default copy (either order)', async () => {
    for (const order of [[P1A, P1], [P1, P1A]]) {
      await t.reset();
      const v = synthVoters(15, 3);
      const files: FakeFile[] = order.map((p) => ({ relPath: p, code: '24-01-01-001', voters: v, variant: p.includes('A-Z') ? 'alpha' : 'default' }));
      const { deps, sync } = setup(files);
      await sync();
      // process in the given order
      await t.c.sourceFiles.updateMany({}, { $set: { status: 'done' } });
      for (const p of order) {
        await t.c.sourceFiles.updateOne({ relPath: p }, { $set: { status: 'pending' } });
        await runJob(deps, (await createJob(deps, {}))._id);
      }
      const s = await verifyAndAggregate(t.c, { by: 'test', referenceYear: 2026 });
      expect(s.validatedUnique).toBe(15);
      expect(s.rawRowsRead).toBe(30);
      expect(s.reconciliation.pusBalanced).toBe(1);
      expect(s.gender.female).toBe(v.filter((x) => x.gender === 'F').length);
      expect(await t.c.issues.countDocuments({ category: 'VARIANT_DISAGREEMENT' })).toBe(0);
    }
  });

  it('reports gender as unavailable when only the alphabetical copy exists', async () => {
    const { deps, sync } = setup([{ relPath: P3A, code: '24-01-02-001', voters: synthVoters(9, 4), variant: 'alpha' }]);
    await sync();
    await runJob(deps, (await createJob(deps, {}))._id);
    const s = await verifyAndAggregate(t.c, { by: 'test' });
    expect(s.gender).toEqual({ male: 0, female: 0, unavailable: 9 });
    expect(await t.c.issues.findOne({ category: 'GENDER_UNAVAILABLE' })).toMatchObject({ pu: '24-01-02-001', affected: 9 });
  });

  it('recovers from a crash mid-file without duplicating records', async () => {
    const v = synthVoters(20, 5);
    const { deps, sync } = setup([
      { relPath: P1, code: '24-01-01-001', voters: v, variant: 'default' },
      { relPath: P2, code: '24-01-01-002', voters: synthVoters(5, 6), variant: 'default' },
    ]);
    await sync();
    const job = await createJob(deps, {});
    // Simulate a crash: file 1 claimed by a dead worker, half its records already written.
    await t.c.jobs.updateOne({ _id: job._id }, { $set: { status: 'running', heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    const f1 = await t.c.sourceFiles.findOneAndUpdate({ relPath: P1 }, { $set: { status: 'processing' } }, { returnDocument: 'after' });
    await t.c.records.insertMany(
      v.slice(0, 10).map((x) => ({ _id: recordIdOf(KEY, '24-01-01-001', x.vin), pu: '24-01-01-001', ward: '24-01-01', lga: '24-01', vh: 'x', nk: 'x', by: null, g: null, src: { f: f1!._id, p: 1, s: null }, job: job._id, at: new Date() })),
    );
    const r = await runJob(deps, job._id);
    expect(r.status).toBe('completed');
    const s = await verifyAndAggregate(t.c, { by: 'test' });
    expect(s.validatedUnique).toBe(25);
    expect(s.reconciliation).toMatchObject({ pusBalanced: 2, pusUnbalanced: 0 });
    expect(await t.c.sourceFiles.countDocuments({ status: 'done' })).toBe(2);
  });

  it('refuses to start while another worker is alive', async () => {
    const { deps, sync } = setup([{ relPath: P1, code: '24-01-01-001', voters: synthVoters(3), variant: 'default' }]);
    await sync();
    const other = await createJob(deps, {});
    await t.c.jobs.updateOne({ _id: other._id }, { $set: { status: 'running', heartbeatAt: new Date() } });
    await expect(runJob(deps, (await createJob(deps, {}))._id)).rejects.toThrow(/running/);
  });

  it('stops safely at the memory limit and resumes later', async () => {
    const files: FakeFile[] = [P1, P2].map((p, i) => ({ relPath: p, code: `24-01-01-00${i + 1}`, voters: synthVoters(4, i + 7), variant: 'default' }));
    let rss = 900;
    const { deps, sync } = setup(files, { memoryLimitMb: 500, rssMb: () => rss });
    await sync();
    const job = await createJob(deps, {});
    const r1 = await runJob(deps, job._id);
    expect(r1).toMatchObject({ status: 'stopped', stopReason: 'memory_limit', filesProcessed: 1 });
    rss = 100;
    const r2 = await runJob(deps, job._id);
    expect(r2).toMatchObject({ status: 'completed', filesProcessed: 1 });
    expect(await t.c.records.countDocuments()).toBe(8);
  });

  it('isolates unreadable files and does not retry them in a tight loop', async () => {
    const { deps, sync } = setup([
      { relPath: P1, code: '24-01-01-001', voters: synthVoters(3), variant: 'default', broken: true },
      { relPath: P2, code: '24-01-01-002', voters: synthVoters(3, 2), variant: 'default' },
    ]);
    await sync();
    const r = await runJob(deps, (await createJob(deps, {}))._id);
    expect(r.filesProcessed).toBe(2);
    const bad = await t.c.sourceFiles.findOne({ relPath: P1 });
    expect(bad).toMatchObject({ status: 'failed', attempts: 1 });
    expect(bad!.error).toMatch(/Invalid PDF structure/);
    await verifyAndAggregate(t.c, { by: 'test' });
    expect(await t.c.issues.findOne({ category: 'FILE_UNREADABLE' })).toMatchObject({ severity: 'critical', status: 'open' });
  });

  it('detects count mismatches and VINs that appear in two polling units', async () => {
    const shared = synthVoters(6, 9);
    const { deps, sync } = setup([
      { relPath: P1, code: '24-01-01-001', voters: shared, variant: 'default', coverRecords: 8 },
      { relPath: P2, code: '24-01-01-002', voters: [shared[0]!, ...synthVoters(2, 10)], variant: 'default' },
    ]);
    await sync();
    await runJob(deps, (await createJob(deps, {}))._id);
    const s = await verifyAndAggregate(t.c, { by: 'test' });
    expect(s.reconciliation.pusUnbalanced).toBe(1);
    expect(await t.c.issues.findOne({ category: 'COUNT_MISMATCH' })).toMatchObject({ pu: '24-01-01-001', affected: 2, severity: 'critical' });
    expect(s.duplicateVinRecords).toBe(2);
    expect(await t.c.issues.countDocuments({ category: 'DUPLICATE_VIN_ACROSS_PUS' })).toBe(2);
  });

  it('auto-resolves issues that are no longer detected, keeping history', async () => {
    const { deps, sync } = setup([{ relPath: P1, code: '24-01-01-001', voters: synthVoters(3), variant: 'default', broken: true }]);
    await sync();
    await runJob(deps, (await createJob(deps, {}))._id);
    await verifyAndAggregate(t.c, { by: 'test' });
    expect(await t.c.issues.countDocuments({ category: 'FILE_UNREADABLE', status: 'open' })).toBe(1);
    await t.c.sourceFiles.updateOne({ relPath: P1 }, { $set: { status: 'pending', attempts: 0 } });
    const { deps: fixed } = setup([{ relPath: P1, code: '24-01-01-001', voters: synthVoters(3), variant: 'default' }]);
    await runJob(fixed, (await createJob(fixed, {}))._id);
    await verifyAndAggregate(t.c, { by: 'test' });
    const issue = await t.c.issues.findOne({ category: 'FILE_UNREADABLE' });
    expect(issue!.status).toBe('resolved');
    expect(issue!.history.map((h) => h.action)).toEqual(['detected', 'auto_resolved']);
  });

  it('marks changed source files instead of silently re-using old results', async () => {
    const files: FakeFile[] = [{ relPath: P1, code: '24-01-01-001', voters: synthVoters(3), variant: 'default' }];
    const { deps } = setup(files);
    await syncCatalog(deps, { entries: files.map(entry), unrecognised: [] });
    await runJob(deps, (await createJob(deps, {}))._id);
    const changed = files.map(entry).map((e) => ({ ...e, size: e.size + 1 }));
    const r = await syncCatalog(deps, { entries: changed, unrecognised: [] });
    expect(r.changed).toBe(1);
    expect((await t.c.sourceFiles.findOne({ relPath: P1 }))!.status).toBe('changed');
  });
});
