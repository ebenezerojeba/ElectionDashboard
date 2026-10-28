import { Router, type Request } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import type { AggDoc } from '../db.js';
import { assertScope, audit, HttpError, requirePerm } from '../http.js';
import { describeScope, scopeFilter, scopeRoots } from '../scope.js';
import { renderCsv, renderPdf, renderXlsx, type ReportData } from '../services/renderers.js';
import { can, ROLE_LABELS, type Permission } from '../../shared/roles.js';
import { LAGOS_STATE_CODE, levelOf } from '../../shared/geo.js';
import { METRICS } from '../../shared/metrics.js';
import { activeExercise } from './collation.js';
import { datasetInfo } from './stats.js';
import type { VerificationSummary } from '../../worker/verify.js';
import { auditRows, DEFAULT_ASSUMPTIONS, planRows } from '../services/insights.js';
import { renderBrief } from '../services/brief.js';
import { parseAssumptions } from './insights.js';

type Builder = (req: Request, code: string, base: Omit<ReportData, 'title' | 'columns' | 'rows' | 'source' | 'limitations'>) => Promise<ReportData>;

const COMMON_LIMITS = [
  'Aggregate figures only; no individual voter details are included.',
  'Figures derive from the register files supplied and are not official INEC statistics.',
];

async function verificationNote(req: Request): Promise<{ status: string; period: string }> {
  const v = (await req.ctx.c.settings.findOne({ _id: 'verification' }))?.value as VerificationSummary | undefined;
  if (!v) return { status: 'Not yet verified', period: 'Not available' };
  const r = v.reconciliation;
  return {
    status: `Verified ${new Date(v.at).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${r.pusBalanced} polling units balanced, ${r.pusUnbalanced} unbalanced, ${r.pusPartial} not fully processed`,
    period: `Register printed ${v.referenceYear}`,
  };
}

const geoColumns = [
  { key: 'code', label: 'Code' },
  { key: 'name', label: 'Area' },
  { key: 'records', label: 'Validated records', type: 'int' as const },
  { key: 'expected', label: 'Register cover total', type: 'int' as const },
  { key: 'rejected', label: 'Rejected rows', type: 'int' as const },
  { key: 'female', label: 'Female', type: 'int' as const },
  { key: 'male', label: 'Male', type: 'int' as const },
  { key: 'genderUnknown', label: 'Gender unavailable', type: 'int' as const },
  { key: 'dupVinRecords', label: 'Duplicate VIN candidates', type: 'int' as const },
  { key: 'pusComplete', label: 'PUs complete', type: 'int' as const },
];
const definitions = Object.values(METRICS).map((m) => ({ term: m.label, definition: `${m.definition} Source: ${m.source}.` }));

const BUILDERS: Record<string, { title: string; perms: Permission[]; build: Builder }> = {
  'executive-summary': {
    title: 'Executive Summary',
    perms: ['reports.export', 'stats.read'],
    build: async (req, code, base) => {
      const unit = await req.ctx.c.agg.findOne({ _id: code });
      const children = await req.ctx.c.agg.find({ parent: code }).sort({ _id: 1 }).toArray();
      const rows = [unit, ...children].filter(Boolean).map((d, i) => ({ ...d, code: d!._id, name: i === 0 ? `TOTAL — ${d!.name}` : d!.name }));
      return { ...base, title: 'Executive Summary', columns: geoColumns, rows, source: 'Aggregates computed from the validated register records', limitations: [...COMMON_LIMITS, 'Gender is unavailable for polling units supplied only as alphabetical copies.'], definitions };
    },
  },
  'geo-aggregate': {
    title: 'Geographic Aggregate Report',
    perms: ['reports.export', 'stats.read'],
    build: async (req, code, base) => {
      const level = req.query.level === 'pu' ? 'pu' : req.query.level === 'ward' ? 'ward' : null;
      const filter = (level ? { level, ...(code === LAGOS_STATE_CODE ? {} : { _id: { $regex: '^' + code.replace(/-/g, '\\-') + '-' } }) } : { parent: code }) as Filter<AggDoc>;
      const docs = await req.ctx.c.agg.find(filter).sort({ _id: 1 }).limit(20000).toArray();
      return { ...base, title: 'Geographic Aggregate Report', filters: { ...base.filters, level: level ?? 'children' }, columns: geoColumns, rows: docs.map((d) => ({ ...d, code: d._id })), source: 'Aggregates computed from the validated register records', limitations: COMMON_LIMITS, definitions };
    },
  },
  'data-quality': {
    title: 'Data Quality Summary',
    perms: ['reports.export', 'quality.read'],
    build: async (req, code, base) => {
      const match = code === LAGOS_STATE_CODE ? scopeFilter(req.user!.scope) : levelOf(code) === 'lga' ? { lga: code } : levelOf(code) === 'ward' ? { ward: code } : { pu: code };
      const rows = await req.ctx.c.issues
        .aggregate<{ _id: { category: string; severity: string; status: string }; issues: number; affected: number }>([
          { $match: match },
          { $group: { _id: { category: '$category', severity: '$severity', status: '$status' }, issues: { $sum: 1 }, affected: { $sum: '$affected' } } },
          { $sort: { '_id.category': 1, '_id.status': 1 } },
        ])
        .toArray();
      return {
        ...base,
        title: 'Data Quality Summary',
        columns: [{ key: 'category', label: 'Category' }, { key: 'severity', label: 'Severity' }, { key: 'status', label: 'Status' }, { key: 'issues', label: 'Issues', type: 'int' }, { key: 'affected', label: 'Affected count', type: 'int' }],
        rows: rows.map((r) => ({ ...r._id, issues: r.issues, affected: r.affected })),
        source: 'Data-quality rules applied during import verification',
        limitations: [...COMMON_LIMITS, 'Duplicate findings are candidates requiring review, not confirmed duplicates.'],
      };
    },
  },
  'import-jobs': {
    title: 'Import Job Results',
    perms: ['reports.export', 'imports.read'],
    build: async (req, _code, base) => {
      const jobs = await req.ctx.c.jobs.find({}).sort({ createdAt: -1 }).limit(500).toArray();
      const counts = await req.ctx.c.sourceFiles
        .aggregate<{ _id: ObjectId; files: number; rows: number; rejected: number }>([
          { $match: { status: 'done' } },
          { $group: { _id: '$jobId', files: { $sum: 1 }, rows: { $sum: '$counts.parsed' }, rejected: { $sum: '$counts.rejected' } } },
        ])
        .toArray();
      return {
        ...base,
        title: 'Import Job Results',
        scope: 'All source files',
        columns: [
          { key: 'id', label: 'Job' }, { key: 'status', label: 'Status' }, { key: 'prefix', label: 'Path filter' }, { key: 'createdAt', label: 'Created', type: 'date' }, { key: 'finishedAt', label: 'Finished', type: 'date' },
          { key: 'files', label: 'Files (last processed by job)', type: 'int' }, { key: 'rows', label: 'Rows accepted', type: 'int' }, { key: 'rejected', label: 'Rows rejected', type: 'int' }, { key: 'peakRssMb', label: 'Peak memory MB', type: 'int' }, { key: 'stopReason', label: 'Stop reason' },
        ],
        rows: jobs.map((j) => {
          const c = counts.find((x) => x._id?.equals(j._id));
          return { id: j._id.toHexString(), status: j.status, prefix: j.options.pathPrefix ?? '(all)', createdAt: j.createdAt, finishedAt: j.finishedAt, files: c?.files ?? 0, rows: c?.rows ?? 0, rejected: c?.rejected ?? 0, peakRssMb: j.peakRssMb, stopReason: j.stopReason ?? '' };
        }),
        source: 'Import job and per-file records',
        limitations: ['Files re-processed by a later job are attributed to that later job.'],
      };
    },
  },
  reconciliation: {
    title: 'Reconciliation Report',
    perms: ['reports.export', 'quality.read'],
    build: async (req, code, base) => {
      const filter = { level: 'pu' as const, ...(code === LAGOS_STATE_CODE ? {} : { _id: { $regex: '^' + code.replace(/-/g, '\\-') + '-' } }) };
      const docs = await req.ctx.c.agg.find(filter).sort({ _id: 1 }).limit(20000).toArray();
      return {
        ...base,
        title: 'Reconciliation Report',
        columns: [
          { key: 'code', label: 'PU code' }, { key: 'name', label: 'Polling unit' }, { key: 'expected', label: 'Register cover total', type: 'int' }, { key: 'records', label: 'Validated records', type: 'int' },
          { key: 'rejected', label: 'Rejected rows', type: 'int' }, { key: 'difference', label: 'Difference', type: 'int' }, { key: 'state', label: 'Status' },
        ],
        rows: docs.map((d) => ({
          code: d._id, name: d.name, expected: d.pusComplete ? d.expected : null, records: d.records, rejected: d.rejected,
          difference: d.pusComplete ? (d.expected ?? 0) - d.records - d.rejected : null,
          state: !d.pusComplete ? 'Not fully processed' : (d.expected ?? 0) === d.records + d.rejected ? 'Balanced' : 'UNBALANCED',
        })),
        source: 'Register cover totals compared with stored and rejected rows',
        limitations: COMMON_LIMITS,
      };
    },
  },
  'submission-status': {
    title: 'Ward and LGA Submission Status',
    perms: ['reports.export', 'collation.read'],
    build: async (req, code, base) => {
      const exercise = await activeExercise(req);
      const wardFilter = { level: 'ward' as const, ...(code === LAGOS_STATE_CODE ? scopeFilter(req.user!.scope) : { _id: { $regex: '^' + code.replace(/-/g, '\\-') } }) };
      const [wards, subs, lgas] = await Promise.all([
        req.ctx.c.geo.find(wardFilter).sort({ _id: 1 }).toArray(),
        req.ctx.c.submissions.find({ exercise: exercise.id }).toArray(),
        req.ctx.c.geo.find({ level: 'lga' }).toArray(),
      ]);
      return {
        ...base,
        title: 'Ward and LGA Submission Status',
        period: exercise.label,
        columns: [{ key: 'lga', label: 'LGA' }, { key: 'ward', label: 'Ward code' }, { key: 'name', label: 'Ward' }, { key: 'status', label: 'Status' }, { key: 'submittedAt', label: 'Submitted', type: 'date' }, { key: 'receiptNo', label: 'Receipt' }, { key: 'discrepancies', label: 'Discrepancies', type: 'int' }],
        rows: wards.map((w) => {
          const s = subs.find((x) => x.ward === w._id);
          return { lga: lgas.find((l) => l._id === w.lga)?.name ?? w.lga, ward: w._id, name: w.name, status: s?.status ?? 'missing', submittedAt: s?.submittedAt ?? null, receiptNo: s?.receiptNo ?? '', discrepancies: s?.discrepancies?.length ?? 0 };
        }),
        source: 'Internal collation submissions',
        limitations: ['Internal party reporting only; these are not official election results.'],
      };
    },
  },
  'officer-activity': {
    title: 'Officer Activity Report',
    perms: ['reports.export', 'collation.read'],
    build: async (req, code, base) => {
      const since = new Date(Date.now() - 30 * 86_400_000);
      const match: Record<string, unknown> = { action: { $regex: '^collation\\.' }, at: { $gte: since } };
      if (code !== LAGOS_STATE_CODE) match.target = { $regex: '^' + code.replace(/-/g, '\\-') };
      else if (req.user!.scope.level !== 'state') match.target = { $in: [] }; // restricted users must pick an area
      const rows = await req.ctx.c.audit
        .aggregate<{ _id: { email: string; role: string; action: string }; n: number; last: Date }>([{ $match: match }, { $group: { _id: { email: '$actorEmail', role: '$actorRole', action: '$action' }, n: { $sum: 1 }, last: { $max: '$at' } } }, { $sort: { '_id.email': 1 } }])
        .toArray();
      return {
        ...base,
        title: 'Officer Activity Report',
        period: `Last 30 days (since ${since.toISOString().slice(0, 10)})`,
        columns: [{ key: 'officer', label: 'Officer' }, { key: 'role', label: 'Role' }, { key: 'action', label: 'Action' }, { key: 'count', label: 'Count', type: 'int' }, { key: 'last', label: 'Most recent', type: 'date' }],
        rows: rows.map((r) => ({ officer: r._id.email, role: ROLE_LABELS[r._id.role as keyof typeof ROLE_LABELS] ?? r._id.role, action: r._id.action.replace('collation.', ''), count: r.n, last: r.last })),
        source: 'Audit log',
        limitations: ['Counts actions recorded in the audit log for the selected area.'],
      };
    },
  },
  'executive-brief': {
    title: 'Executive Brief (one page)',
    perms: ['reports.export', 'stats.read'],
    build: async (req, code, base) => {
      // PDF is rendered as a designed one-pager (see services/brief.ts); CSV/XLSX carry the same headline figures.
      const unit = await req.ctx.c.agg.findOne({ _id: code });
      const plan = await planRows(req.ctx.c, code, DEFAULT_ASSUMPTIONS);
      const rows = unit
        ? [
            { metric: 'Validated voters', value: unit.records },
            { metric: 'Register cover total (complete PUs)', value: unit.expected },
            { metric: 'Polling units', value: unit.pus },
            { metric: 'Female', value: unit.female },
            { metric: 'Male', value: unit.male },
            { metric: 'Gender unavailable', value: unit.genderUnknown },
            { metric: 'Duplicate VIN candidates', value: unit.dupVinRecords },
            { metric: 'Youth share 18-34 (%)', value: Math.round(plan.totals.youthShare * 1000) / 10 },
            { metric: 'Estimated field personnel', value: plan.totals.totalAgents },
          ]
        : [];
      return { ...base, title: 'Executive Brief', columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value', type: 'int' }], rows, source: 'Aggregates computed from validated register records', limitations: COMMON_LIMITS, definitions };
    },
  },
  'register-audit': {
    title: 'Register Audit (claims & objections)',
    perms: ['reports.export', 'quality.read'],
    build: async (req, code, base) => {
      const lvl = levelOf(code);
      const groupBy = req.query.level === 'pu' ? 'pu' : req.query.level === 'ward' ? 'ward' : undefined;
      const rows = await auditRows(req.ctx.c, code, req.user!.scope, groupBy);
      return {
        ...base,
        title: 'Register Audit — evidence for claims & objections',
        filters: { ...base.filters, groupedBy: groupBy ?? (lvl === 'state' ? 'lga' : lvl === 'lga' ? 'ward' : 'pu') },
        columns: [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Area' }, { key: 'records', label: 'Validated records', type: 'int' },
          { key: 'dupVin', label: 'VIN in another PU', type: 'int' }, { key: 'possibleDup', label: 'Name matches for manual review (low confidence)', type: 'int' },
          { key: 'badBirthYear', label: 'Implausible birth year', type: 'int' }, { key: 'rejected', label: 'Invalid rows', type: 'int' },
          { key: 'countMismatch', label: 'Count mismatch', type: 'int' }, { key: 'total', label: 'High-confidence findings', type: 'int' }, { key: 'per10k', label: 'High-confidence per 10,000' },
        ],
        rows: [...rows].sort((a, b) => b.total - a.total) as unknown as Record<string, unknown>[],
        source: 'Data-quality rules applied during import verification (open and in-review findings)',
        limitations: [
          ...COMMON_LIMITS,
          'Findings are candidates for review, not confirmed irregularities. Verify each case against the source register before filing an objection with INEC.',
          'Possible duplicate registrations are counted at ward level only (they span polling units).',
        ],
      };
    },
  },
  'ops-plan': {
    title: 'Field Operations Deployment Sheet',
    perms: ['reports.export', 'stats.read'],
    build: async (req, code, base) => {
      const a = parseAssumptions(req.query);
      const { rows, totals } = await planRows(req.ctx.c, code, a);
      return {
        ...base,
        title: 'Field Operations Deployment Sheet',
        filters: { ...base.filters, assumptions: `threshold ${a.threshold}; +1 agent per ${a.extraPer} above; ${a.wardAgents}/ward; ${a.lgaSupervisors}/LGA` },
        columns: [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Area' }, { key: 'wards', label: 'Wards', type: 'int' }, { key: 'pus', label: 'Polling units', type: 'int' },
          { key: 'voters', label: 'Voters', type: 'int' }, { key: 'avgPerPu', label: 'Avg voters/PU', type: 'int' }, { key: 'pusOverThreshold', label: `PUs > ${a.threshold}`, type: 'int' },
          { key: 'puAgents', label: 'PU agents', type: 'int' }, { key: 'extraAgents', label: 'Extra agents', type: 'int' }, { key: 'collationAgents', label: 'Collation agents', type: 'int' },
          { key: 'supervisors', label: 'Supervisors', type: 'int' }, { key: 'totalAgents', label: 'Total personnel', type: 'int' }, { key: 'youthShare', label: 'Youth 18-34', type: 'pct' },
        ],
        rows: [...rows, { ...totals, name: 'TOTAL' }] as unknown as Record<string, unknown>[],
        source: 'Polling-unit aggregates from validated register records',
        limitations: ['Planning estimate only. Adjust assumptions to party deployment policy.', ...COMMON_LIMITS],
      };
    },
  },
};

export const REPORT_TYPES = Object.entries(BUILDERS).map(([id, b]) => ({ id, title: b.title, perms: b.perms }));

export function reportsRouter(): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json({ items: REPORT_TYPES.filter((t) => t.perms.every((p) => can(req.user!.role, p))).map(({ id, title }) => ({ id, title })) });
  });

  r.get('/:type', async (req, res) => {
    const type = req.params.type;
    const b = BUILDERS[type];
    if (!b) throw new HttpError(404, 'Unknown report', 'not_found');
    const format = String(req.query.format ?? 'pdf');
    if (!['pdf', 'xlsx', 'csv'].includes(format)) throw new HttpError(400, 'Format must be pdf, xlsx or csv', 'validation');
    const u = req.user!;
    const code = String(req.query.scope ?? scopeRoots(u.scope)[0]);
    if (!levelOf(code)) throw new HttpError(400, 'Invalid scope code', 'validation');
    const denied = !b.perms.every((p) => can(u.role, p));
    if (denied) {
      await audit(req, 'report.export', 'denied', type, { format, scope: code });
      await req.ctx.c.exports.insertOne({ _id: new ObjectId(), report: type, format: format as 'pdf', scope: code, filters: {}, rows: 0, userId: u._id, userEmail: u.email, at: new Date(), status: 'denied' });
      throw new HttpError(403, 'You do not have permission to export this report', 'forbidden');
    }
    await assertScope(req, code);
    const v = await verificationNote(req);
    const ds = await datasetInfo(req);
    const scopeName = (await req.ctx.c.geo.findOne({ _id: code }))?.name ?? code;
    const filters: Record<string, string> = {};
    for (const [k, val] of Object.entries(req.query)) if (!['format', 'scope'].includes(k) && typeof val === 'string') filters[k] = val.slice(0, 60);
    const data = await b.build(req, code, {
      id: type,
      generatedAt: new Date(),
      generatedBy: `${u.name} (${ROLE_LABELS[u.role]})`,
      period: v.period,
      scope: `${scopeName} [${code}] — user scope: ${describeScope(u.scope)}`,
      filters,
      validationStatus: v.status,
      synthetic: ds.synthetic,
    });
    const buf =
      type === 'executive-brief' && format === 'pdf'
        ? await renderBrief(req.ctx.c, code, u.scope, { generatedBy: data.generatedBy, synthetic: ds.synthetic, registerMode: ds.mode === 'register' })
        : format === 'csv'
          ? renderCsv(data)
          : format === 'xlsx'
            ? await renderXlsx(data)
            : await renderPdf(data);
    await req.ctx.c.exports.insertOne({ _id: new ObjectId(), report: type, format: format as 'pdf', scope: code, filters, rows: data.rows.length, userId: u._id, userEmail: u.email, at: new Date(), status: 'generated' });
    await audit(req, 'report.export', 'success', type, { format, scope: code, rows: data.rows.length });
    const fname = `${type}_${code}_${data.generatedAt.toISOString().slice(0, 10)}.${format}`;
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  return r;
}
