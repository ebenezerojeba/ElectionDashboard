/**
 * Ingestion CLI.
 *
 *   npm run ingest -- catalog                         scan the source folder (metadata only)
 *   npm run ingest -- estimate                        storage/time estimate from catalogue + pilot measurements
 *   npm run ingest -- pilot --prefix "01_AGEGE/01_ISALE_IDIMANGORO" [--limit 50]
 *   npm run ingest -- verify                          reconcile, aggregate, detect data-quality issues
 *   npm run ingest -- status
 *   npm run ingest -- authorize --by "<full name>" --reference "<approval document ref>"
 *   npm run ingest -- run [--limit N] [--prefix P] [--resume <jobId>]
 *
 * A full run (no --prefix/--limit) is refused until: real keys are configured, an authorization
 * attestation has been recorded, a pilot job has completed and balanced, and the disk check passes.
 * Output never contains names, VINs or other personal values.
 */
import '../server/env.js';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { loadConfig, usingDevKeys } from '../server/config.js';
import { connect, ensureIndexes } from '../server/db.js';
import { extractPdfText, extractWithPypdf } from './pdfText.js';
import { createJob, runJob, syncCatalog, type IngestDeps } from './ingest.js';
import { verifyAndAggregate } from './verify.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

const config = loadConfig();
if (!config.SOURCE_DATA_DIR) {
  console.error('SOURCE_DATA_DIR is not set (see .env.example).');
  process.exit(2);
}
const sourceRoot = path.resolve(config.SOURCE_DATA_DIR);
const { client, c, db } = await connect(config.MONGODB_URI, config.MONGODB_DB);
await ensureIndexes(c);

const deps: IngestDeps = {
  c,
  hashKey: config.RECORD_HASH_KEY,
  sourceRoot,
  memoryLimitMb: Number(flag('memory-mb') ?? config.INGEST_MEMORY_LIMIT_MB),
  batchSize: config.INGEST_BATCH_SIZE,
  extract: (d) => extractPdfText(d),
  fallbackExtract: config.INGEST_PYTHON ? (p) => extractWithPypdf(p, config.INGEST_PYTHON!) : undefined,
  log: (m, d) => console.log(`[${new Date().toISOString()}] ${m}${d ? ' ' + JSON.stringify(d) : ''}`),
};

async function guardRealData() {
  if (usingDevKeys(config)) {
    console.error('Refusing to process real register files with development keys. Set RECORD_HASH_KEY and APP_ENCRYPTION_KEY in .env.');
    process.exit(2);
  }
  const mode = await c.settings.findOne({ _id: 'dataset' });
  if ((mode?.value as { mode?: string } | undefined)?.mode === 'synthetic') {
    console.error(`Database "${config.MONGODB_DB}" holds synthetic demonstration data. Use a separate database for the register.`);
    process.exit(2);
  }
  await c.settings.updateOne({ _id: 'dataset' }, { $set: { value: { mode: 'register', label: 'INEC display register (restricted)' }, updatedAt: new Date() } }, { upsert: true });
}

async function estimate() {
  const files = await c.sourceFiles.find({}, { projection: { size: 1, status: 1, counts: 1, durationMs: 1, variant: 1 } }).toArray();
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const done = files.filter((f) => f.status === 'done' && f.counts);
  const doneBytes = done.reduce((a, f) => a + f.size, 0);
  const doneRows = done.reduce((a, f) => a + (f.counts!.parsed + f.counts!.rejected), 0);
  const doneMs = done.reduce((a, f) => a + (f.durationMs ?? 0), 0);
  const rowsPerByte = doneBytes ? doneRows / doneBytes : null;
  const estRawRows = rowsPerByte ? Math.round(rowsPerByte * totalBytes) : null;
  // Second copies (alphabetical) create no new records, so treating every row as unique is an upper bound.
  const dfltBytes = files.filter((f) => f.variant === 'default').reduce((a, f) => a + f.size, 0);
  let bytesPerRecord: number | null = null;
  const nRecords = await c.records.estimatedDocumentCount();
  if (nRecords > 0) {
    const s = (await db.command({ collStats: 'voter_records' })) as { storageSize: number; totalIndexSize: number };
    bytesPerRecord = (s.storageSize + s.totalIndexSize) / nRecords;
  }
  const estDbBytes = estRawRows && bytesPerRecord ? estRawRows * bytesPerRecord : null;
  const dbPath = process.env.LOCAL_MONGO_DBPATH ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'LagosEIP', 'mongodb');
  let freeBytes: number | null = null;
  try {
    const fs = await statfs(dbPath);
    freeBytes = fs.bavail * fs.bsize;
  } catch {
    /* remote DB or path missing */
  }
  // Need room for collection + indexes, WiredTiger working files, one compressed backup, and a safety margin.
  const requiredBytes = estDbBytes ? estDbBytes * 2.5 + 5 * 1024 ** 3 : null;
  const result = {
    catalogue: { files: files.length, totalGB: +(totalBytes / 1024 ** 3).toFixed(2), defaultCopyGB: +(dfltBytes / 1024 ** 3).toFixed(2) },
    measuredOn: { files: done.length, rows: doneRows, avgMsPerFile: done.length ? Math.round(doneMs / done.length) : null },
    estimate: {
      rawRowsAllCopies: estRawRows,
      bytesPerStoredRecord: bytesPerRecord ? Math.round(bytesPerRecord) : null,
      dbGB_upperBound: estDbBytes ? +(estDbBytes / 1024 ** 3).toFixed(2) : null,
      requiredFreeGB: requiredBytes ? +(requiredBytes / 1024 ** 3).toFixed(2) : null,
      hoursAtMeasuredSpeed: done.length ? +(((doneMs / done.length) * files.length) / 3.6e6).toFixed(1) : null,
    },
    disk: { dbPath, freeGB: freeBytes ? +(freeBytes / 1024 ** 3).toFixed(1) : null },
    sufficient: requiredBytes && freeBytes ? freeBytes > requiredBytes : null,
  };
  return result;
}

try {
  switch (cmd) {
    case 'catalog': {
      const r = await syncCatalog(deps);
      out({ ...r, totalGB: +(r.totalBytes / 1024 ** 3).toFixed(2), unrecognised: r.unrecognised.length });
      break;
    }
    case 'estimate':
      out(await estimate());
      break;
    case 'status': {
      const byStatus = await c.sourceFiles.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
      const jobs = await c.jobs.find({}, { sort: { createdAt: -1 }, limit: 5 }).toArray();
      out({ files: Object.fromEntries(byStatus.map((s) => [s._id, s.n])), records: await c.records.estimatedDocumentCount(), recentJobs: jobs });
      break;
    }
    case 'authorize': {
      const by = flag('by');
      const reference = flag('reference');
      if (!by || !reference) throw new Error('Usage: authorize --by "<full name>" --reference "<approval reference>"');
      await c.settings.updateOne(
        { _id: 'authorization' },
        { $set: { value: { by, reference, at: new Date(), host: os.hostname(), statement: 'Processing of the register is authorised and compliant with applicable data protection and electoral requirements.' }, updatedAt: new Date() } },
        { upsert: true },
      );
      await c.audit.insertOne({ at: new Date(), action: 'import.authorization_recorded', outcome: 'success', detail: { by, reference } });
      out({ recorded: true, by, reference });
      break;
    }
    case 'pilot':
    case 'run': {
      await guardRealData();
      const prefix = flag('prefix');
      const limit = flag('limit') ? Number(flag('limit')) : undefined;
      const isFull = cmd === 'run' && !prefix && !limit;
      if (cmd === 'pilot' && !prefix && !limit) throw new Error('A pilot needs --prefix and/or --limit');
      if (isFull) {
        const auth = await c.settings.findOne({ _id: 'authorization' });
        if (!auth) throw new Error('Full import refused: no authorization attestation recorded (run "authorize").');
        const ver = (await c.settings.findOne({ _id: 'verification' }))?.value as { reconciliation?: { pusBalanced: number; pusUnbalanced: number } } | undefined;
        if (!ver?.reconciliation?.pusBalanced || ver.reconciliation.pusUnbalanced > 0)
          throw new Error('Full import refused: no balanced pilot verification on record (run a pilot, then "verify").');
        const est = await estimate();
        if (est.sufficient === false) throw new Error(`Full import refused: insufficient disk space (${JSON.stringify(est.disk)}; need ${est.estimate.requiredFreeGB} GB)`);
        if (est.sufficient === null && !has('skip-disk-check')) throw new Error('Full import refused: disk requirement could not be estimated (run a pilot first).');
      }
      const resume = flag('resume');
      const job = resume ? await c.jobs.findOne({ _id: new ObjectId(resume) }) : await createJob(deps, { limitFiles: limit, pathPrefix: prefix, createdBy: `cli:${os.userInfo().username}` });
      if (!job) throw new Error('Job not found');
      const ac = new AbortController();
      process.on('SIGINT', () => {
        console.log('Interrupt received — finishing the current file, then stopping safely…');
        ac.abort();
      });
      console.log(`Job ${job._id} starting (memory limit ${deps.memoryLimitMb} MB)`);
      const r = await runJob(deps, job._id, ac.signal);
      out({ jobId: job._id, ...r });
      break;
    }
    case 'retry-failed': {
      const r = await c.sourceFiles.updateMany({ status: 'failed' }, { $set: { status: 'pending', attempts: 0 }, $unset: { error: '' } });
      await c.audit.insertOne({ at: new Date(), action: 'import.retry_failed', outcome: 'success', detail: { files: r.modifiedCount } });
      out({ reset: r.modifiedCount });
      break;
    }
    case 'verify': {
      const s = await verifyAndAggregate(c, { by: 'cli' });
      out(s);
      break;
    }
    default:
      console.log('Commands: catalog | estimate | status | authorize | pilot | run | retry-failed | verify');
  }
} finally {
  await client.close();
}
