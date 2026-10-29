import { Router } from 'express';
import type { Filter } from 'mongodb';
import { z } from 'zod';
import { aggregateOnly, audit, HttpError, pageParams, parse, requirePerm } from '../http.js';
import { can } from '../../shared/roles.js';
import { canAccessCode, scopeFilter, scopeRoots } from '../scope.js';
import { METRICS } from '../../shared/metrics.js';
import { nameKeyOf, vinHashOf } from '../crypto.js';
import { normaliseName } from '../../worker/parser.js';
import { rateLimit } from '../http.js';
import type { DqIssueDoc } from '../db.js';
import type { VerificationSummary } from '../../worker/verify.js';
import { verifyAndAggregate } from '../../worker/verify.js';

export async function datasetInfo(req: import('express').Request) {
  const mode = (await req.ctx.c.settings.findOne({ _id: 'dataset' }))?.value as { mode?: string; label?: string } | undefined;
  return { mode: mode?.mode ?? 'empty', label: mode?.label ?? 'No dataset loaded', synthetic: mode?.mode === 'synthetic' };
}

export function statsRouter(): Router {
  const r = Router();

  r.get('/overview', requirePerm('stats.read'), async (req, res) => {
    const { c } = req.ctx;
    const u = req.user!;
    const scope = u.scope;
    const roots = scopeRoots(scope);
    const rootAgg = await c.agg.find({ _id: { $in: roots } }).toArray();
    const sum = (k: 'records' | 'rejected' | 'dupVinRecords' | 'expected' | 'male' | 'female' | 'genderUnknown' | 'pus' | 'pusWithData' | 'pusComplete') =>
      rootAgg.reduce((a, d) => a + (d[k] ?? 0), 0);
    const verification = (await c.settings.findOne({ _id: 'verification' })) as { value: VerificationSummary; updatedAt: Date } | null;
    const stateWide = scope.level === 'state';
    const v = verification?.value;

    const metrics: Record<string, { value: number | null } & (typeof METRICS)[keyof typeof METRICS]> = {
      validatedUnique: { ...METRICS.validatedUnique, value: sum('records') },
      expected: { ...METRICS.expected, value: sum('expected') },
      rejectedRows: { ...METRICS.rejectedRows, value: sum('rejected') },
      duplicateVinRecords: { ...METRICS.duplicateVinRecords, value: sum('dupVinRecords') },
      genderUnknown: { ...METRICS.genderUnknown, value: sum('genderUnknown') },
    };
    if (stateWide && v) {
      metrics.rawRowsRead = { ...METRICS.rawRowsRead, value: v.rawRowsRead };
      metrics.possibleDuplicateGroups = { ...METRICS.possibleDuplicateGroups, value: v.possibleDuplicateGroups };
    }

    const issueMatch: Filter<DqIssueDoc> = { status: { $in: ['open', 'in_review'] }, ...scopeFilter(scope) };
    const issuesBySeverity = can(u.role, 'quality.read')
      ? await c.issues.aggregate<{ _id: string; n: number; affected: number }>([{ $match: issueMatch }, { $group: { _id: '$severity', n: { $sum: 1 }, affected: { $sum: '$affected' } } }]).toArray()
      : [];

    const latestJob = can(u.role, 'imports.read') ? await c.jobs.findOne({}, { sort: { createdAt: -1 } }) : null;
    const lastCompleted = can(u.role, 'imports.read') ? await c.jobs.findOne({ status: 'completed' }, { sort: { finishedAt: -1 } }) : null;
    const fileStatus = can(u.role, 'imports.read') ? await c.sourceFiles.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray() : [];

    const pendingApprovals = can(u.role, 'collation.read')
      ? await c.submissions.countDocuments({ status: 'submitted', ...scopeFilter(scope) })
      : null;
    const recentExports = can(u.role, 'reports.export')
      ? await c.exports.find(u.role === 'system_admin' || u.role === 'report_reviewer' ? {} : { userId: u._id }, { sort: { at: -1 }, limit: 8 }).toArray()
      : [];

    res.json({
      dataset: await datasetInfo(req),
      scope: { level: scope.level, roots },
      reportingPeriod: v ? { registerPrintedYear: v.referenceYear, verifiedAt: v.at } : null,
      metrics,
      coverage: stateWide && v ? v.coverage : { pus: sum('pusWithData'), pusCatalogued: sum('pus'), pusComplete: sum('pusComplete') },
      reconciliation: stateWide && v ? v.reconciliation : null,
      gender: { male: sum('male'), female: sum('female'), unavailable: sum('genderUnknown') },
      ageBands: rootAgg.reduce<Record<string, number>>((acc, d) => {
        for (const [k, n] of Object.entries(d.ageBands ?? {})) acc[k] = (acc[k] ?? 0) + n;
        return acc;
      }, {}),
      issuesBySeverity,
      imports: latestJob
        ? { latestJob, lastSuccessfulAt: lastCompleted?.finishedAt ?? null, files: Object.fromEntries(fileStatus.map((f) => [f._id, f.n])) }
        : null,
      pendingApprovals,
      recentExports,
    });
  });

  // ---------- Imports (read-only from the web; the worker runs as a separate process) ----------
  r.get('/imports/jobs', requirePerm('imports.read'), async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 100);
    const [items, total] = await Promise.all([req.ctx.c.jobs.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(), req.ctx.c.jobs.countDocuments()]);
    res.json({ items, total, page, limit });
  });

  r.get('/imports/files', requirePerm('imports.read'), async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = {};
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    if (typeof req.query.prefix === 'string' && req.query.prefix) filter.relPath = { $regex: '^' + req.query.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    const projection = { sha256: 0 };
    const [items, total] = await Promise.all([
      req.ctx.c.sourceFiles.find(filter, { projection }).sort({ relPath: 1 }).skip(skip).limit(limit).toArray(),
      req.ctx.c.sourceFiles.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  });

  r.get('/imports/summary', requirePerm('imports.read'), async (req, res) => {
    const { c } = req.ctx;
    const [byStatus, catalog, verification, auth] = await Promise.all([
      c.sourceFiles.aggregate([{ $group: { _id: '$status', files: { $sum: 1 }, bytes: { $sum: '$size' }, rows: { $sum: { $add: [{ $ifNull: ['$counts.parsed', 0] }, { $ifNull: ['$counts.rejected', 0] }] } } } }]).toArray(),
      c.settings.findOne({ _id: 'catalog' }),
      c.settings.findOne({ _id: 'verification' }),
      c.settings.findOne({ _id: 'authorization' }),
    ]);
    res.json({ byStatus, catalog: catalog?.value ?? null, verification: verification?.value ?? null, authorization: auth?.value ?? null });
  });

  r.post('/imports/verify', requirePerm('imports.manage'), async (req, res) => {
    // Without individual records, re-verification would erase the aggregates.
    if (aggregateOnly()) throw new HttpError(409, 'Verification runs on the secure office machine, not in the online deployment', 'aggregate_only');
    const running = await req.ctx.c.jobs.findOne({ status: 'running', heartbeatAt: { $gt: new Date(Date.now() - 120_000) } });
    if (running) throw new HttpError(409, 'An import is running; verify after it finishes', 'conflict');
    const s = await verifyAndAggregate(req.ctx.c, { by: req.user!.email });
    await audit(req, 'import.verify', 'success', undefined, { validatedUnique: s.validatedUnique, unbalanced: s.reconciliation.pusUnbalanced });
    res.json(s);
  });

  // ---------- Data quality ----------
  r.get('/quality/summary', requirePerm('quality.read'), async (req, res) => {
    const match = scopeFilter(req.user!.scope);
    const rows = await req.ctx.c.issues
      .aggregate([
        { $match: match },
        { $group: { _id: { category: '$category', status: '$status', severity: '$severity' }, issues: { $sum: 1 }, affected: { $sum: '$affected' } } },
        { $sort: { '_id.category': 1 } },
      ])
      .toArray();
    res.json({ rows });
  });

  r.get('/quality/issues', requirePerm('quality.read'), async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Filter<DqIssueDoc> = { ...scopeFilter(req.user!.scope) };
    for (const k of ['category', 'severity', 'status', 'lga', 'ward', 'pu'] as const) {
      const v = req.query[k];
      if (typeof v === 'string' && v) (filter as Record<string, unknown>)[k] = v;
    }
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const [items, total] = await Promise.all([
      req.ctx.c.issues.find(filter, { projection: { refs: 0 } }).sort({ lastDetectedAt: -1, _id: 1 }).skip(skip).limit(limit).toArray(),
      req.ctx.c.issues.countDocuments(filter),
    ]);
    items.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    res.json({ items, total, page, limit });
  });

  r.get('/quality/issues/:id', requirePerm('quality.read'), async (req, res) => {
    const issue = await req.ctx.c.issues.findOne({ _id: req.params.id, ...scopeFilter(req.user!.scope) });
    if (!issue) throw new HttpError(404, 'Issue not found', 'not_found');
    // Source references (file + page) are for data stewards only.
    if (!can(req.user!.role, 'quality.manage')) issue.refs = [];
    else {
      const files = await req.ctx.c.sourceFiles.find({ _id: { $in: issue.refs.map((r) => r.fileKey) } }, { projection: { relPath: 1, status: 1, error: 1 } }).toArray();
      (issue as unknown as { files: unknown }).files = files;
    }
    res.json(issue);
  });

  r.patch('/quality/issues/:id', requirePerm('quality.manage'), async (req, res) => {
    const body = parse(z.object({ status: z.enum(['open', 'in_review', 'resolved', 'accepted_risk']), note: z.string().trim().min(3).max(2000) }), req.body);
    const issue = await req.ctx.c.issues.findOne({ _id: req.params.id, ...scopeFilter(req.user!.scope) });
    if (!issue) throw new HttpError(404, 'Issue not found', 'not_found');
    await req.ctx.c.issues.updateOne(
      { _id: issue._id },
      { $set: { status: body.status }, $push: { history: { at: new Date(), by: req.user!.email, action: 'status_change', from: issue.status, to: body.status, note: body.note } } },
    );
    await audit(req, 'quality.issue_update', 'success', issue._id, { from: issue.status, to: body.status });
    res.json({ ok: true });
  });

  // ---------- Restricted individual lookup (data stewards; audited; no names returned) ----------
  // Registration check by full name + birth year (like INEC's own verification portal).
  // Names are stored only as a keyed fingerprint, so this confirms a specific person; it cannot browse or partially match.
  const lookupLimiter = rateLimit({ name: 'name-lookup', windowMs: 60 * 60_000, max: 60, key: (q) => q.user?._id.toHexString() ?? 'anon' });
  r.post('/records/name-lookup', requirePerm('records.check'), lookupLimiter, async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(3).max(120),
        birthYear: z.coerce.number().int().min(1900).max(2015),
        lga: z.string().regex(/^24-\d{2}$/).optional().or(z.literal('')),
        reason: z.string().trim().min(5).max(300),
      }),
      req.body,
    );
    const norm = normaliseName(body.name);
    if (norm.split(' ').length < 2) throw new HttpError(400, 'Enter at least a surname and a first name, as printed on the voter card', 'validation');
    const nk = nameKeyOf(req.ctx.config.RECORD_HASH_KEY, norm, body.birthYear);
    // Query through the {ward, nk} index: one seek per ward in scope.
    if (aggregateOnly()) {
      // Online: compact fingerprint index (bucket = first 4 hex chars; entries = 14-byte remainder + 2-byte PU index).
      const meta = await req.ctx.c.nameIndex.findOne({ _id: 'pus' });
      // Without a published index every search would look like "not registered" — say so instead.
      if (!meta?.codes?.length) throw new HttpError(503, 'The online registration index has not been published yet. Use the office machine for checks.', 'index_unavailable');
      const bucket = await req.ctx.c.nameIndex.findOne({ _id: nk.slice(0, 4) });
      const want = Buffer.from(nk.slice(4), 'hex');
      const pus: string[] = [];
      const blob = bucket?.b ? Buffer.from(bucket.b.buffer) : Buffer.alloc(0);
      for (let i = 0; i + 16 <= blob.length; i += 16) {
        if (blob.compare(want, 0, 14, i, i + 14) === 0) {
          const code = meta?.codes?.[blob.readUInt16BE(i + 14)];
          if (code && canAccessCode(req.user!.scope, code) && (!body.lga || code.startsWith(body.lga + '-'))) pus.push(code);
        }
      }
      const geo = new Map((await req.ctx.c.geo.find({ _id: { $in: [...new Set(pus.flatMap((p) => [p, p.slice(0, 8), p.slice(0, 5)]))] } }, { projection: { name: 1 } }).toArray()).map((g) => [g._id, g.name]));
      await audit(req, 'records.name_lookup', 'success', undefined, { matches: pus.length, reason: body.reason, lgaFilter: body.lga || null, source: 'online_index' });
      return res.json({
        searched: { name: norm, birthYear: body.birthYear },
        matches: pus.slice(0, 20).map((p) => ({ pu: p, puName: geo.get(p) ?? p, ward: p.slice(0, 8), wardName: geo.get(p.slice(0, 8)) ?? p.slice(0, 8), lga: p.slice(0, 5), lgaName: geo.get(p.slice(0, 5)) ?? p.slice(0, 5), birthYear: body.birthYear, gender: null })),
      });
    }
    const wardFilter: Record<string, unknown> = { level: 'ward', ...scopeFilter(req.user!.scope) };
    if (body.lga) wardFilter.lga = body.lga;
    const wards = (await req.ctx.c.geo.find(wardFilter, { projection: { _id: 1 } }).toArray()).map((w) => w._id);
    const recs = await req.ctx.c.records.find({ ward: { $in: wards }, nk }, { projection: { pu: 1, ward: 1, lga: 1, by: 1, g: 1 } }).limit(20).toArray();
    const names = new Map((await req.ctx.c.geo.find({ _id: { $in: [...new Set(recs.flatMap((x) => [x.pu, x.ward, x.lga]))] } }, { projection: { name: 1 } }).toArray()).map((g) => [g._id, g.name]));
    // The searched name is never written to the audit log — only that a check happened, the match count and the reason.
    await audit(req, 'records.name_lookup', 'success', undefined, { matches: recs.length, reason: body.reason, lgaFilter: body.lga || null });
    res.json({
      searched: { name: norm, birthYear: body.birthYear },
      matches: recs.map((x) => ({ pu: x.pu, puName: names.get(x.pu) ?? x.pu, ward: x.ward, wardName: names.get(x.ward) ?? x.ward, lga: x.lga, lgaName: names.get(x.lga) ?? x.lga, birthYear: x.by, gender: x.g })),
    });
  });

  r.post('/records/lookup', requirePerm('records.lookup'), async (req, res) => {
    if (aggregateOnly()) throw new HttpError(409, 'Individual register lookups are only available on the secure office machine', 'aggregate_only');
    const { vin, reason } = parse(z.object({ vin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{18,20}$/, 'VIN format is invalid'), reason: z.string().trim().min(5).max(300) }), req.body);
    const vh = vinHashOf(req.ctx.config.RECORD_HASH_KEY, vin);
    const recs = await req.ctx.c.records.find({ vh, ...scopeFilter(req.user!.scope) }, { projection: { pu: 1, ward: 1, lga: 1, by: 1, g: 1, src: 1 } }).limit(10).toArray();
    const files = await req.ctx.c.sourceFiles.find({ _id: { $in: recs.map((r) => r.src.f) } }, { projection: { relPath: 1 } }).toArray();
    // The VIN itself is never written to the audit log — only that a lookup happened and why.
    await audit(req, 'records.lookup', 'success', undefined, { matches: recs.length, reason });
    res.json({
      matches: recs.map((r) => ({ pu: r.pu, ward: r.ward, lga: r.lga, birthYear: r.by, gender: r.g, source: { file: files.find((f) => f._id === r.src.f)?.relPath ?? null, page: r.src.p + 1, serial: r.src.s } })),
    });
  });

  // ---------- Audit log ----------
  r.get('/audit', requirePerm('audit.read'), async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = {};
    if (typeof req.query.action === 'string' && req.query.action) filter.action = { $regex: '^' + req.query.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    if (typeof req.query.outcome === 'string' && req.query.outcome) filter.outcome = req.query.outcome;
    if (typeof req.query.actor === 'string' && req.query.actor) filter.actorEmail = req.query.actor.toLowerCase();
    const [items, total] = await Promise.all([req.ctx.c.audit.find(filter).sort({ at: -1 }).skip(skip).limit(limit).toArray(), req.ctx.c.audit.countDocuments(filter)]);
    res.json({ items, total, page, limit });
  });

  return r;
}
