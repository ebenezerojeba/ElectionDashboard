import { Router } from 'express';
import { assertScope, HttpError, requirePerm } from '../http.js';
import { scopeRoots } from '../scope.js';
import { levelOf } from '../../shared/geo.js';
import { auditRows, DEFAULT_ASSUMPTIONS, planRows, situation, type PlanAssumptions } from '../services/insights.js';
import { activeExercise } from './collation.js';

export function parseAssumptions(q: Record<string, unknown>): PlanAssumptions {
  const n = (k: keyof PlanAssumptions, min: number, max: number) => {
    const v = Number(q[k]);
    return Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : DEFAULT_ASSUMPTIONS[k];
  };
  return { threshold: n('threshold', 100, 5000), extraPer: n('extraPer', 50, 5000), wardAgents: n('wardAgents', 0, 20), lgaSupervisors: n('lgaSupervisors', 0, 50) };
}

export function insightsRouter(): Router {
  const r = Router();

  const scopeCode = async (req: import('express').Request) => {
    const code = String(req.query.scope ?? scopeRoots(req.user!.scope)[0]);
    if (!levelOf(code) || levelOf(code) === 'pu') throw new HttpError(400, 'Choose the state, an LGA or a ward', 'validation');
    await assertScope(req, code);
    return code;
  };

  r.get('/audit', requirePerm('quality.read'), async (req, res) => {
    const code = await scopeCode(req);
    const rows = await auditRows(req.ctx.c, code, req.user!.scope);
    const totals = rows.reduce(
      (a, x) => ({ records: a.records + x.records, dupVin: a.dupVin + x.dupVin, possibleDup: a.possibleDup + x.possibleDup, badBirthYear: a.badBirthYear + x.badBirthYear, rejected: a.rejected + x.rejected, countMismatch: a.countMismatch + x.countMismatch, total: a.total + x.total }),
      { records: 0, dupVin: 0, possibleDup: 0, badBirthYear: 0, rejected: 0, countMismatch: 0, total: 0 },
    );
    res.json({ scope: code, rows, totals });
  });

  r.get('/plan', requirePerm('stats.read'), async (req, res) => {
    const code = await scopeCode(req);
    const a = parseAssumptions(req.query);
    const { rows, totals } = await planRows(req.ctx.c, code, a);
    res.json({ scope: code, assumptions: a, rows, totals });
  });

  r.get('/situation', requirePerm('collation.read'), async (req, res) => {
    const ex = await activeExercise(req);
    res.json({ ...(await situation(req.ctx.c, ex.id, req.user!.scope)), exerciseLabel: ex.label });
  });

  return r;
}
