/**
 * Resumable, memory-bounded ingestion of register PDFs into MongoDB.
 *
 * Safety properties
 *  - Source files are opened read-only and never modified, moved or copied.
 *  - One file is processed at a time; memory is bounded by the largest file (~20 MB) plus parser overhead.
 *  - Record ids are deterministic (HMAC of PU code + VIN), and writes are upserts,
 *    so re-processing a file after a crash, or loading both copies of a polling unit, never duplicates.
 *  - A file is marked `done` only after its writes complete. Files left `processing` by a crashed
 *    worker are reset to `pending` on the next run.
 *  - Counters shown to users are derived from stored per-file results, not incremented in flight.
 *  - Names and VINs exist only in memory during parsing; only keyed hashes are written.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnyBulkWriteOperation, ObjectId } from 'mongodb';
import type { Collections, ImportJobDoc, SourceFileDoc, VoterRecordDoc, RejectDoc } from '../server/db.js';
import { nameKeyOf, recordIdOf, vinHashOf } from '../server/crypto.js';
import { parsePuCode } from '../shared/geo.js';
import { scanSource, type CatalogEntry } from './catalog.js';
import { parseDocument, normaliseName, yearOf } from './parser.js';

export type Extractor = (data: Uint8Array) => Promise<{ pageCount: number; pages: string[][]; pageErrors: number[] }>;

export interface IngestDeps {
  c: Collections;
  hashKey: string;
  sourceRoot: string;
  memoryLimitMb: number;
  batchSize: number;
  extract: Extractor;
  /** Optional tolerant extractor for damaged files (reads from the path). */
  fallbackExtract?: (absPath: string) => ReturnType<Extractor>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Overridable for tests. */
  readSource?: (absPath: string) => Promise<Uint8Array>;
  rssMb?: () => number;
  defaultReferenceYear?: number;
}

const STALE_HEARTBEAT_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // Error messages from the PDF library describe structure, not content; still cap the length.
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogSyncResult {
  scanned: number;
  added: number;
  unchanged: number;
  changed: number;
  missing: number;
  unrecognised: string[];
  totalBytes: number;
}

export async function syncCatalog(deps: IngestDeps, scanned?: { entries: CatalogEntry[]; unrecognised: string[] }): Promise<CatalogSyncResult> {
  const { c } = deps;
  const { entries, unrecognised } = scanned ?? (await scanSource(deps.sourceRoot));
  const existing = new Map((await c.sourceFiles.find({}, { projection: { size: 1, mtimeMs: 1, status: 1 } }).toArray()).map((d) => [d._id, d]));
  const res: CatalogSyncResult = { scanned: entries.length, added: 0, unchanged: 0, changed: 0, missing: 0, unrecognised, totalBytes: 0 };
  const ops: AnyBulkWriteOperation<SourceFileDoc>[] = [];
  const now = new Date();
  for (const e of entries) {
    res.totalBytes += e.size;
    const prev = existing.get(e.fileKey);
    existing.delete(e.fileKey);
    if (!prev) {
      res.added++;
      ops.push({
        insertOne: {
          document: {
            _id: e.fileKey,
            relPath: e.relPath,
            size: e.size,
            mtimeMs: e.mtimeMs,
            variant: e.variant,
            letterRange: e.letterRange,
            part: e.part,
            partOf: e.partOf,
            impliedPuCode: e.impliedPuCode,
            lgaFolderName: e.lgaFolderName,
            wardFolderName: e.wardFolderName,
            puFileName: e.puFileName,
            status: 'pending',
            attempts: 0,
            catalogedAt: now,
          },
        },
      });
    } else if (prev.size !== e.size || prev.mtimeMs !== e.mtimeMs) {
      res.changed++;
      ops.push({
        updateOne: {
          filter: { _id: e.fileKey },
          update: { $set: { size: e.size, mtimeMs: e.mtimeMs, status: prev.status === 'pending' ? 'pending' : 'changed', catalogedAt: now } },
        },
      });
    } else {
      res.unchanged++;
    }
  }
  res.missing = existing.size; // in DB but no longer on disk — reported, never auto-deleted
  for (let i = 0; i < ops.length; i += 1000) await c.sourceFiles.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  await c.settings.updateOne(
    { _id: 'catalog' },
    { $set: { value: { ...res, unrecognised: res.unrecognised.slice(0, 200), missingKeys: [...existing.keys()].slice(0, 200), at: now }, updatedAt: now } },
    { upsert: true },
  );
  return res;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function createJob(
  deps: IngestDeps,
  opts: { limitFiles?: number; pathPrefix?: string; createdBy?: string },
): Promise<ImportJobDoc> {
  const job: ImportJobDoc = {
    _id: new (await import('mongodb')).ObjectId(),
    kind: 'register_pdf',
    sourceRoot: path.basename(deps.sourceRoot),
    status: 'created',
    options: { limitFiles: opts.limitFiles, pathPrefix: opts.pathPrefix, memoryLimitMb: deps.memoryLimitMb, batchSize: deps.batchSize },
    createdBy: opts.createdBy,
    createdAt: new Date(),
  };
  await deps.c.jobs.insertOne(job);
  return job;
}

export interface RunResult {
  status: ImportJobDoc['status'];
  filesProcessed: number;
  stopReason?: string;
  peakRssMb: number;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function runJob(deps: IngestDeps, jobId: ObjectId, signal?: AbortSignal): Promise<RunResult> {
  const { c } = deps;
  const log = deps.log ?? (() => {});
  const rss = deps.rssMb ?? (() => Math.round(process.memoryUsage().rss / 1048576));
  const read = deps.readSource ?? (async (p: string) => new Uint8Array(await readFile(p)));

  // Refuse to run if another worker is alive.
  const live = await c.jobs.findOne({ status: 'running', _id: { $ne: jobId }, heartbeatAt: { $gt: new Date(Date.now() - STALE_HEARTBEAT_MS) } });
  if (live) throw new Error(`Another import job (${live._id}) is running`);
  // Any other "running" job is stale (crashed worker).
  await c.jobs.updateMany({ status: 'running', _id: { $ne: jobId } }, { $set: { status: 'stopped', stopReason: 'stale_worker', finishedAt: new Date() } });
  // Crash recovery: files stuck in processing return to pending (their writes are idempotent).
  const recovered = await c.sourceFiles.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
  if (recovered.modifiedCount) log('recovered interrupted files', { files: recovered.modifiedCount });

  const job = await c.jobs.findOneAndUpdate(
    { _id: jobId, status: { $in: ['created', 'stopped', 'failed', 'running'] } },
    { $set: { status: 'running', startedAt: new Date(), heartbeatAt: new Date(), workerPid: process.pid, filesProcessedThisRun: 0 }, $unset: { stopReason: '' } },
    { returnDocument: 'after' },
  );
  if (!job) throw new Error('Job not found or already completed');

  const filter: Record<string, unknown> = {
    $or: [{ status: 'pending' }, { status: 'changed' }, { status: 'failed', attempts: { $lt: MAX_ATTEMPTS } }],
  };
  if (job.options.pathPrefix) filter.relPath = { $regex: '^' + escapeRegex(job.options.pathPrefix) };

  let processed = 0;
  let peak = rss();
  let stopReason: string | undefined;
  const failedThisRun: string[] = []; // a failed file is retried on a later run, not in a tight loop
  while (true) {
    filter._id = { $nin: failedThisRun };
    if (signal?.aborted) {
      stopReason = 'interrupted';
      break;
    }
    if (job.options.limitFiles && processed >= job.options.limitFiles) {
      stopReason = 'file_limit_reached';
      break;
    }
    const file = await c.sourceFiles.findOneAndUpdate(
      filter,
      { $set: { status: 'processing', jobId, startedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { relPath: 1 }, returnDocument: 'after' },
    );
    if (!file) break; // nothing left
    try {
      await processFile(deps, file, jobId, read);
    } catch (e) {
      failedThisRun.push(file._id);
      await c.sourceFiles.updateOne({ _id: file._id }, { $set: { status: 'failed', error: sanitizeError(e), finishedAt: new Date() } });
      log('file failed', { file: file._id.slice(0, 8), error: sanitizeError(e) });
    }
    processed++;
    const now = rss();
    peak = Math.max(peak, now);
    await c.jobs.updateOne({ _id: jobId }, { $set: { heartbeatAt: new Date(), peakRssMb: peak }, $inc: { filesProcessedThisRun: 1 } });
    if (now > deps.memoryLimitMb) {
      // Give the GC a chance before stopping.
      (globalThis as { gc?: () => void }).gc?.();
      if (rss() > deps.memoryLimitMb) {
        stopReason = 'memory_limit';
        log('memory limit reached, stopping safely', { rssMb: now, limitMb: deps.memoryLimitMb });
        break;
      }
    }
    if (processed % 25 === 0) log('progress', { processed, rssMb: now });
  }

  const remaining = await c.sourceFiles.countDocuments(filter);
  const status: ImportJobDoc['status'] = stopReason && remaining > 0 ? 'stopped' : 'completed';
  await c.jobs.updateOne(
    { _id: jobId },
    { $set: { status, finishedAt: new Date(), peakRssMb: peak, ...(stopReason && status === 'stopped' ? { stopReason } : {}) } },
  );
  return { status, filesProcessed: processed, stopReason: status === 'stopped' ? stopReason : undefined, peakRssMb: peak };
}

async function processFile(deps: IngestDeps, file: SourceFileDoc, jobId: ObjectId, read: (p: string) => Promise<Uint8Array>) {
  const { c, hashKey } = deps;
  const t0 = Date.now();
  const abs = path.join(deps.sourceRoot, ...file.relPath.split('/'));
  const data = await read(abs);
  const sha256 = createHash('sha256').update(data).digest('hex');
  let text: Awaited<ReturnType<Extractor>> | null = null;
  let extractor: 'pdfjs' | 'pypdf' = 'pdfjs';
  let primaryError: unknown;
  try {
    text = await deps.extract(data);
  } catch (e) {
    primaryError = e;
  }
  // Damaged files: fall back to the more tolerant extractor and keep whichever reads more pages.
  if ((!text || text.pageErrors.length > 0) && deps.fallbackExtract) {
    try {
      const fb = await deps.fallbackExtract(abs);
      if (!text || fb.pageErrors.length < text.pageErrors.length) {
        text = fb;
        extractor = 'pypdf';
      }
    } catch {
      /* keep the primary result (or its error) */
    }
  }
  if (!text) throw primaryError ?? new Error('Text extraction failed');
  const doc = parseDocument(text.pages, deps.defaultReferenceYear ?? new Date().getFullYear());

  const coverCode = doc.cover.puCode ? parsePuCode(doc.cover.puCode) : null;
  if (!coverCode) throw new Error('Cover page has no valid polling-unit code');
  const pu = coverCode.pu;
  const now = new Date();

  // Gender is taken only from the default copy: inspection showed the alphabetical copy marks every voter "M".
  const trustGender = file.variant === 'default';

  let inserted = 0;
  let matched = 0;
  const ops: AnyBulkWriteOperation<VoterRecordDoc>[] = [];
  const flush = async () => {
    if (!ops.length) return;
    const r = await c.records.bulkWrite(ops.splice(0, ops.length), { ordered: false });
    inserted += r.upsertedCount;
    matched += r.matchedCount;
  };
  for (const r of doc.records) {
    const id = recordIdOf(hashKey, pu, r.vin);
    const setOnInsert: Partial<VoterRecordDoc> = {
      pu,
      ward: coverCode.ward,
      lga: coverCode.lga,
      vh: vinHashOf(hashKey, r.vin),
      nk: nameKeyOf(hashKey, normaliseName(r.name), r.birthYear),
      by: r.birthYear,
      src: { f: file._id, p: r.page, s: r.serial },
      job: jobId,
      at: now,
    };
    const update: Record<string, unknown> = { $addToSet: { cp: file.variant === 'default' ? 'd' : 'a' } };
    if (trustGender) {
      update.$set = { g: r.gender };
      update.$setOnInsert = setOnInsert;
    } else {
      update.$setOnInsert = { ...setOnInsert, g: null };
    }
    ops.push({ updateOne: { filter: { _id: id }, update, upsert: true } });
    if (ops.length >= deps.batchSize) await flush();
  }
  await flush();

  // Rejected rows: location + reason only (no personal values).
  if (doc.rejected.length) {
    const rejOps: AnyBulkWriteOperation<RejectDoc>[] = doc.rejected.map((r, i) => ({
      replaceOne: {
        filter: { _id: `${file._id}:${r.page}:${r.serial ?? 'x' + i}` },
        replacement: { _id: `${file._id}:${r.page}:${r.serial ?? 'x' + i}`, fileKey: file._id, pu, page: r.page, serial: r.serial, reasons: r.reasons, job: jobId, at: now },
        upsert: true,
      },
    }));
    await c.rejects.bulkWrite(rejOps, { ordered: false });
  }

  const issues: Record<string, number> = {};
  for (const i of doc.issues) issues[i.code] = (issues[i.code] ?? 0) + 1;
  for (const p of text.pageErrors) issues.PAGE_EXTRACT_ERROR = (issues.PAGE_EXTRACT_ERROR ?? 0) + (p >= 0 ? 1 : 0);

  await c.sourceFiles.updateOne(
    { _id: file._id },
    {
      $set: {
        status: 'done',
        sha256,
        extractor,
        puCode: pu,
        cover: {
          records: doc.cover.records,
          pages: doc.cover.pages,
          printedDate: doc.cover.printedDate,
          listType: doc.cover.listType,
          lgaName: doc.cover.lgaName,
          wardName: doc.cover.wardName,
          puName: doc.cover.puName,
        },
        counts: { pages: text.pageCount, dataPages: doc.dataPages, parsed: doc.records.length, rejected: doc.rejected.length, inserted, matched },
        issues,
        finishedAt: new Date(),
        durationMs: Date.now() - t0,
      },
      $unset: { error: '' },
    },
  );
}

export { yearOf };
