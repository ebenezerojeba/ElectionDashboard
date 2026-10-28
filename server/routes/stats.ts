import { Router } from 'express';
import type { Filter } from 'mongodb';
import { z } from 'zod';
import { audit, HttpError, pageParams, parse, requirePerm } from '../http.js';
import { can } from '../../shared/roles.js';
import { scopeFilter, scopeRoots } from '../scope.js';
import { METRICS } from '../../shared/metrics.js';
import { vinHashOf } from '../crypto.js';
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
  r.post('/records/lookup', requirePerm('records.lookup'), async (req, res) => {
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
