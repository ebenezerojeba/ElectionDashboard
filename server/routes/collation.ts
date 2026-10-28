/**
 * Ward / LGA collation workflow for INTERNAL party reporting.
 * Submissions are internal reports, not official election results.
 *
 *   draft --submit--> submitted --approve--> approved
 *                         |
 *                         +--return--> returned --submit--> submitted ...
 */
import { Router, type Request } from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assertScope, audit, HttpError, pageParams, parse, requirePerm } from '../http.js';
import { scopeFilter } from '../scope.js';
import { validateUpload } from '../services/media.js';
import type { CollationTemplateDoc, SubmissionDoc } from '../db.js';
import { isLgaCode, isWardCode } from '../../shared/geo.js';
import { can } from '../../shared/roles.js';

export const DEFAULT_TEMPLATE: CollationTemplateDoc = {
  _id: 'ward-situation-v1',
  name: 'Ward Situation Report',
  description: 'Internal ward-level situation report submitted by the Ward Collation Officer. Not an official result sheet.',
  active: true,
  updatedAt: new Date(0),
  fields: [
    { key: 'pus_total', label: 'Polling units in ward', type: 'integer', required: true, min: 0, max: 2000, help: 'Pre-filled from the register reference where available.' },
    { key: 'pus_reported', label: 'Polling units reporting', type: 'integer', required: true, min: 0, max: 2000, help: 'Cannot exceed polling units in ward.' },
    { key: 'agents_deployed', label: 'Party agents deployed', type: 'integer', required: true, min: 0, max: 10000 },
    { key: 'agents_absent', label: 'Party agents absent', type: 'integer', required: false, min: 0, max: 10000 },
    { key: 'materials_status', label: 'Materials status', type: 'select', required: true, options: ['Complete', 'Partial', 'Not received'] },
    { key: 'incidents_count', label: 'Incidents recorded', type: 'integer', required: true, min: 0, max: 10000 },
    { key: 'incident_summary', label: 'Incident summary', type: 'text', required: false },
    { key: 'remarks', label: 'Remarks', type: 'text', required: false },
  ],
};

/** Returns field errors (empty object = valid). `forSubmit` enforces required fields. */
export function validateValues(t: CollationTemplateDoc, values: Record<string, unknown>, forSubmit: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of t.fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (forSubmit && f.required) errors[f.key] = 'Required';
      continue;
    }
    if (f.type === 'integer') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n)) errors[f.key] = 'Must be a whole number';
      else if (f.min !== undefined && n < f.min) errors[f.key] = `Must be at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `Must be at most ${f.max}`;
    } else if (f.type === 'select') {
      if (!f.options?.includes(String(v))) errors[f.key] = 'Choose one of the listed options';
    } else if (String(v).length > 4000) errors[f.key] = 'Too long (max 4000 characters)';
  }
  for (const k of Object.keys(values)) if (!t.fields.some((f) => f.key === k)) errors[k] = 'Unknown field';
  // Cross-field rules for the default template.
  const n = (k: string) => (values[k] === undefined || values[k] === null || values[k] === '' ? null : Number(values[k]));
  if (n('pus_reported') !== null && n('pus_total') !== null && n('pus_reported')! > n('pus_total')! && !errors.pus_reported)
    errors.pus_reported = 'Cannot exceed polling units in ward';
  if (n('agents_absent') !== null && n('agents_deployed') !== null && n('agents_absent')! > n('agents_deployed')! && !errors.agents_absent)
    errors.agents_absent = 'Cannot exceed agents deployed';
  return errors;
}

function normalise(t: CollationTemplateDoc, values: Record<string, unknown>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const f of t.fields) {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') out[f.key] = null;
    else out[f.key] = f.type === 'integer' ? Number(v) : String(v).trim();
  }
  return out;
}

export async function activeExercise(req: Request): Promise<{ id: string; label: string }> {
  const s = (await req.ctx.c.settings.findOne({ _id: 'collation' }))?.value as { exercise?: string; label?: string } | undefined;
  return { id: s?.exercise ?? 'DEFAULT', label: s?.label ?? 'Default reporting exercise' };
}

async function template(req: Request, id: string): Promise<CollationTemplateDoc> {
  const t = (await req.ctx.c.templates.findOne({ _id: id })) ?? (id === DEFAULT_TEMPLATE._id ? DEFAULT_TEMPLATE : null);
  if (!t) throw new HttpError(404, 'Reporting template not found', 'not_found');
  return t;
}

async function loadSubmission(req: Request, rawId: unknown): Promise<SubmissionDoc> {
  const id = String(rawId);
  if (!ObjectId.isValid(id)) throw new HttpError(404, 'Submission not found', 'not_found');
  const s = await req.ctx.c.submissions.findOne({ _id: new ObjectId(id) });
  if (!s) throw new HttpError(404, 'Submission not found', 'not_found');
  await assertScope(req, s.ward);
  return s;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

export function collationRouter(): Router {
  const r = Router();
  r.use(requirePerm('collation.read'));

  r.get('/context', async (req, res) => {
    const templates = await req.ctx.c.templates.find({ active: true }).toArray();
    res.json({ exercise: await activeExercise(req), templates: templates.length ? templates : [DEFAULT_TEMPLATE], notice: 'Internal reporting only. Submissions are not official election results.' });
  });

  r.get('/submissions', async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 200);
    const exercise = (await activeExercise(req)).id;
    const filter: Record<string, unknown> = { exercise: typeof req.query.exercise === 'string' ? req.query.exercise : exercise, ...scopeFilter(req.user!.scope) };
    for (const k of ['ward', 'lga', 'status'] as const) if (typeof req.query[k] === 'string' && req.query[k]) filter[k] = req.query[k];
    const [items, total] = await Promise.all([
      req.ctx.c.submissions.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray(),
      req.ctx.c.submissions.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  });

  r.get('/submissions/:id', async (req, res) => {
    res.json(await loadSubmission(req, req.params.id));
  });

  r.post('/submissions', requirePerm('collation.submit'), async (req, res) => {
    const { ward, templateId } = parse(z.object({ ward: z.string().refine(isWardCode, 'Invalid ward code'), templateId: z.string().default(DEFAULT_TEMPLATE._id) }), req.body);
    await assertScope(req, ward);
    const t = await template(req, templateId);
    const exercise = (await activeExercise(req)).id;
    const existing = await req.ctx.c.submissions.findOne({ exercise, ward, templateId: t._id });
    if (existing) return res.status(200).json(existing);
    const agg = await req.ctx.c.agg.findOne({ _id: ward }, { projection: { pus: 1 } });
    const now = new Date();
    const doc: SubmissionDoc = {
      _id: new ObjectId(),
      exercise,
      templateId: t._id,
      ward,
      lga: ward.split('-').slice(0, 2).join('-'),
      status: 'draft',
      values: normalise(t, { pus_total: agg?.pus ?? null }),
      attachments: [],
      createdBy: req.user!._id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [{ at: now, by: req.user!.email, action: 'created' }],
    };
    await req.ctx.c.submissions.insertOne(doc);
    await audit(req, 'collation.create', 'success', ward, { submission: doc._id.toHexString() });
    res.status(201).json(doc);
  });

  r.patch('/submissions/:id', requirePerm('collation.submit'), async (req, res) => {
    const s = await loadSubmission(req, req.params.id);
    const body = parse(z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.null()])), version: z.number().int() }), req.body);
    if (!['draft', 'returned'].includes(s.status)) throw new HttpError(409, `A ${s.status} report cannot be edited`, 'conflict');
    const t = await template(req, s.templateId);
    const errors = validateValues(t, body.values, false);
    if (Object.keys(errors).length) return res.status(400).json({ error: 'validation', message: 'Some fields are invalid', fields: errors });
    const r2 = await req.ctx.c.submissions.findOneAndUpdate(
      { _id: s._id, version: body.version },
      { $set: { values: normalise(t, body.values), updatedAt: new Date() }, $inc: { version: 1 }, $push: { history: { at: new Date(), by: req.user!.email, action: 'saved' } } },
      { returnDocument: 'after' },
    );
    if (!r2) throw new HttpError(409, 'This report was changed elsewhere. Reload and try again.', 'stale');
    res.json(r2);
  });

  r.post('/submissions/:id/submit', requirePerm('collation.submit'), async (req, res) => {
    const s = await loadSubmission(req, req.params.id);
    if (!['draft', 'returned'].includes(s.status)) throw new HttpError(409, `A ${s.status} report cannot be submitted`, 'conflict');
    const t = await template(req, s.templateId);
    const errors = validateValues(t, s.values, true);
    if (Object.keys(errors).length) return res.status(400).json({ error: 'validation', message: 'Complete the required fields before submitting', fields: errors });
    const now = new Date();
    const receiptNo = `R-${s.exercise}-${s.ward}-${String(s.version).padStart(3, '0')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const r2 = await req.ctx.c.submissions.findOneAndUpdate(
      { _id: s._id, version: s.version },
      { $set: { status: 'submitted', submittedAt: now, updatedAt: now, receiptNo }, $inc: { version: 1 }, $push: { history: { at: now, by: req.user!.email, action: 'submitted', note: receiptNo } } },
      { returnDocument: 'after' },
    );
    if (!r2) throw new HttpError(409, 'This report was changed elsewhere. Reload and try again.', 'stale');
    await audit(req, 'collation.submit', 'success', s.ward, { submission: s._id.toHexString(), receiptNo });
    res.json({ submission: r2, receipt: { receiptNo, submittedAt: now, ward: s.ward, exercise: s.exercise, submittedBy: req.user!.email } });
  });

  const review = (action: 'return' | 'approve') =>
    async (req: Request, res: import('express').Response) => {
      const s = await loadSubmission(req, String(req.params.id));
      const { note } = parse(z.object({ note: action === 'return' ? z.string().trim().min(5).max(2000) : z.string().trim().max(2000).optional() }), req.body);
      if (s.status !== 'submitted') throw new HttpError(409, `Only submitted reports can be ${action === 'return' ? 'returned' : 'approved'}`, 'conflict');
      if (s.createdBy.equals(req.user!._id)) throw new HttpError(403, 'You cannot review your own submission', 'forbidden');
      const now = new Date();
      const status = action === 'return' ? 'returned' : 'approved';
      await req.ctx.c.submissions.updateOne(
        { _id: s._id, version: s.version },
        { $set: { status, reviewedBy: req.user!._id, reviewedAt: now, updatedAt: now }, $inc: { version: 1 }, $push: { history: { at: now, by: req.user!.email, action: status, note } } },
      );
      await audit(req, `collation.${action}`, 'success', s.ward, { submission: s._id.toHexString() });
      res.json({ ok: true, status });
    };
  r.post('/submissions/:id/return', requirePerm('collation.review'), review('return'));
  r.post('/submissions/:id/approve', requirePerm('collation.review'), review('approve'));

  r.post('/submissions/:id/discrepancy', requirePerm('collation.review'), async (req, res) => {
    const s = await loadSubmission(req, req.params.id);
    const { field, note } = parse(z.object({ field: z.string().max(60), note: z.string().trim().min(5).max(2000) }), req.body);
    const now = new Date();
    await req.ctx.c.submissions.updateOne({ _id: s._id }, { $push: { discrepancies: { field, note, at: now, by: req.user!.email }, history: { at: now, by: req.user!.email, action: 'discrepancy', note: `${field}: ${note}` } } });
    await audit(req, 'collation.discrepancy', 'success', s.ward, { submission: s._id.toHexString(), field });
    res.json({ ok: true });
  });

  r.post('/submissions/:id/attachments', requirePerm('collation.submit'), upload.single('file'), async (req, res) => {
    const s = await loadSubmission(req, String(req.params.id));
    if (!['draft', 'returned'].includes(s.status)) throw new HttpError(409, 'Attachments can only be added to draft or returned reports', 'conflict');
    if (s.attachments.length >= 5) throw new HttpError(400, 'At most 5 attachments per report', 'validation');
    const file = req.file;
    if (!file) throw new HttpError(400, 'No file uploaded', 'validation');
    const problem = validateUpload(file.buffer, 'submission');
    if (problem) {
      await audit(req, 'collation.attachment', 'denied', s.ward, { reason: problem });
      throw new HttpError(400, problem, 'validation');
    }
    const up = await req.ctx.media.upload(file.buffer, { purpose: 'submission', mime: file.mimetype, filename: file.originalname });
    const att = { publicId: up.publicId, format: up.format, bytes: up.bytes, originalName: file.originalname.slice(0, 120), uploadedAt: new Date() };
    await req.ctx.c.submissions.updateOne({ _id: s._id }, { $push: { attachments: att, history: { at: new Date(), by: req.user!.email, action: 'attachment_added', note: att.originalName } } });
    await req.ctx.c.media.insertOne({ _id: new ObjectId(), publicId: up.publicId, resourceType: up.resourceType, deliveryType: up.deliveryType, purpose: 'submission', format: up.format, bytes: up.bytes, uploadedBy: req.user!._id, at: new Date() });
    await audit(req, 'collation.attachment', 'success', s.ward, { submission: s._id.toHexString(), bytes: up.bytes });
    res.status(201).json(att);
  });

  r.get('/submissions/:id/attachments/:n', async (req, res) => {
    const s = await loadSubmission(req, req.params.id);
    const att = s.attachments[Number(req.params.n)];
    if (!att) throw new HttpError(404, 'Attachment not found', 'not_found');
    const media = await req.ctx.c.media.findOne({ publicId: att.publicId });
    const url = req.ctx.media.signedUrl(att.publicId, media?.resourceType ?? 'raw', att.format, 300);
    await audit(req, 'collation.attachment_view', 'success', s.ward, { submission: s._id.toHexString() });
    res.json({ url, expiresInSeconds: 300 });
  });

  /** LGA overview: every ward with its submission status, missing reports, and consolidated totals. */
  r.get('/lga/:lga/status', async (req, res) => {
    const lga = req.params.lga;
    if (!isLgaCode(lga)) throw new HttpError(400, 'Invalid LGA code', 'validation');
    await assertScope(req, lga);
    const exercise = (await activeExercise(req)).id;
    const [wards, subs] = await Promise.all([
      req.ctx.c.geo.find({ level: 'ward', lga }).sort({ _id: 1 }).toArray(),
      req.ctx.c.submissions.find({ exercise, lga }).toArray(),
    ]);
    const t = DEFAULT_TEMPLATE;
    const numeric = t.fields.filter((f) => f.type === 'integer').map((f) => f.key);
    const totals = (status: string[]) =>
      Object.fromEntries(numeric.map((k) => [k, subs.filter((s) => status.includes(s.status)).reduce((a, s) => a + (Number(s.values[k]) || 0), 0)]));
    const rows = wards.map((w) => {
      const s = subs.find((x) => x.ward === w._id);
      return { ward: w._id, name: w.name, status: s?.status ?? 'missing', submissionId: s?._id ?? null, submittedAt: s?.submittedAt ?? null, discrepancies: s?.discrepancies?.length ?? 0, values: s?.values ?? null };
    });
    const counts = rows.reduce<Record<string, number>>((a, r2) => ((a[r2.status] = (a[r2.status] ?? 0) + 1), a), {});
    res.json({
      lga,
      exercise,
      wards: rows,
      counts,
      consolidated: { approvedOnly: totals(['approved']), approvedAndPending: totals(['approved', 'submitted']) },
      canReview: can(req.user!.role, 'collation.review'),
    });
  });

  return r;
}
