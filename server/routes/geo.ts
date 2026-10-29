import { Router } from 'express';
import type { Filter } from 'mongodb';
import { assertScope, HttpError, pageParams, requirePerm } from '../http.js';
import { canAccessCode, scopeRoots } from '../scope.js';
import type { AggDoc, GeoUnitDoc } from '../db.js';

import { AGE_BANDS, LAGOS_STATE_CODE, levelOf, parentOf } from '../../shared/geo.js';
import { SENATORIAL_DISTRICTS } from '../../shared/senatorial.js';

const SORTABLE = new Set(['name', '_id', 'records', 'expected', 'rejected', 'dupVinRecords', 'female', 'male', 'genderUnknown']);

export function geoRouter(): Router {
  const r = Router();
  r.use(requirePerm('stats.read'));

  /** Areas the user may start from (state for state-wide users; their LGAs/wards otherwise). */
  r.get('/roots', async (req, res) => {
    const roots = scopeRoots(req.user!.scope);
    const docs = await req.ctx.c.agg.find({ _id: { $in: roots } }).toArray();
    const names = await req.ctx.c.geo.find({ _id: { $in: roots } }).toArray();
    res.json({ items: roots.map((code) => docs.find((d) => d._id === code) ?? { _id: code, name: names.find((n) => n._id === code)?.name ?? code, level: levelOf(code), records: 0 }) });
  });

  /** One area with its breadcrumbs and children. */
  r.get('/node/:code', async (req, res) => {
    const code = req.params.code;
    if (!levelOf(code)) throw new HttpError(400, 'Invalid area code', 'validation');
    await assertScope(req, code);
    const { c } = req.ctx;
    const unit = await c.agg.findOne({ _id: code });
    const geo = await c.geo.findOne({ _id: code });
    if (!unit && !geo) throw new HttpError(404, 'Area not found', 'not_found');
    const crumbs: { code: string; name: string; accessible: boolean }[] = [];
    let p: string | null = code === LAGOS_STATE_CODE ? null : (parentOf(code) ?? LAGOS_STATE_CODE);
    if (levelOf(code) === 'lga') p = LAGOS_STATE_CODE;
    while (p) {
      const g = await c.geo.findOne({ _id: p }, { projection: { name: 1 } });
      crumbs.unshift({ code: p, name: g?.name ?? p, accessible: canAccessCode(req.user!.scope, p) });
      p = p === LAGOS_STATE_CODE ? null : levelOf(p) === 'lga' ? LAGOS_STATE_CODE : parentOf(p);
    }
    const children = await c.agg.find({ parent: code }).sort({ _id: 1 }).toArray();
    res.json({ unit: unit ?? { ...geo, records: 0 }, geo, breadcrumbs: crumbs, children });
  });

  /** Paginated, sortable table of areas under a parent (table alternative to the map). */
  r.get('/table', async (req, res) => {
    const parent = String(req.query.parent ?? LAGOS_STATE_CODE);
    await assertScope(req, parent);
    const { page, limit, skip } = pageParams(req.query, 500);
    const sortKey = SORTABLE.has(String(req.query.sort)) ? String(req.query.sort) : '_id';
    const dir = req.query.dir === 'desc' ? -1 : 1;
    const level = req.query.level;
    const filter: Filter<AggDoc> = {};
    if (level === 'ward' || level === 'pu') {
      // all descendants of the given level under parent
      filter.level = level;
      if (parent !== LAGOS_STATE_CODE) filter._id = { $regex: '^' + parent.replace(/-/g, '\\-') + '-' };
    } else {
      filter.parent = parent;
    }
    const [items, total] = await Promise.all([
      req.ctx.c.agg.find(filter).sort({ [sortKey]: dir, _id: 1 }).skip(skip).limit(limit).toArray(),
      req.ctx.c.agg.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  });

  /** Senatorial districts: totals are the sum of each district's LGAs (state-wide users). */
  r.get('/districts', async (req, res) => {
    await assertScope(req, LAGOS_STATE_CODE);
    const lgas = await req.ctx.c.agg.find({ level: 'lga' }).toArray();
    const NUM = ['records', 'expected', 'rejected', 'male', 'female', 'genderUnknown', 'dupVinRecords', 'pus', 'pusWithData', 'pusComplete'] as const;
    const items = SENATORIAL_DISTRICTS.map((d) => {
      const members = lgas.filter((l) => d.lgas.includes(l._id));
      const sum = Object.fromEntries(NUM.map((k) => [k, members.reduce((a, l) => a + (Number(l[k]) || 0), 0)]));
      const ageBands = Object.fromEntries(AGE_BANDS.map((b) => [b, members.reduce((a, l) => a + (l.ageBands?.[b] ?? 0), 0)]));
      return { code: d.code, name: d.name, color: d.color, lgas: members.map((l) => ({ code: l._id, name: l.name, records: l.records })).sort((a, b) => b.records - a.records), ...sum, ageBands };
    });
    res.json({ items });
  });

  /** Boundary polygons (LGA level) within scope, with attribution. */
  r.get('/boundaries', async (req, res) => {
    const level = req.query.level === 'ward' ? 'ward' : 'lga';
    const docs = await req.ctx.c.boundaries.find({ level }).toArray();
    const visible = docs.filter((d) => canAccessCode(req.user!.scope, d._id) || req.user!.scope.level === 'state');
    res.json({
      type: 'FeatureCollection',
      attribution: visible[0] ? `${visible[0].source} — ${visible[0].license}` : null,
      features: visible.map((d) => ({ type: 'Feature', id: d._id, properties: { code: d._id, featureName: d.featureName }, geometry: d.geometry })),
    });
  });

  /** Search areas by name or code within the user's scope. */
  r.get('/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ items: [] });
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter: Filter<GeoUnitDoc> = { $or: [{ name: { $regex: esc, $options: 'i' } }, { _id: { $regex: '^' + esc } }] };
    const scope = req.user!.scope;
    if (scope.level !== 'state') {
      filter.$and = [{ $or: scope.codes.map((s) => ({ $or: [{ _id: s }, { _id: { $regex: '^' + s.replace(/-/g, '\\-') + '-' } }] })) }];
    }
    const items = await req.ctx.c.geo.find(filter).sort({ level: 1, name: 1 }).limit(25).toArray();
    res.json({ items });
  });

  return r;
}
