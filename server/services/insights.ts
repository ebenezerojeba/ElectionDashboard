/**
 * Aggregate insights for leadership: register audit, field-operations planning and
 * collation situation. Everything here works on aggregates and issue summaries —
 * no individual voter data is read or returned.
 */
import type { Collections, AggDoc } from '../db.js';
import type { GeoScope } from '../../shared/roles.js';
import { LAGOS_STATE_CODE, levelOf } from '../../shared/geo.js';
import { scopeFilter } from '../scope.js';

const esc = (s: string) => s.replace(/-/g, '\\-');
/** Filter for documents with lga/ward/pu fields beneath `code`. */
function underCode(code: string): Record<string, unknown> {
  const lvl = levelOf(code);
  if (lvl === 'state') return {};
  if (lvl === 'lga') return { lga: code };
  if (lvl === 'ward') return { ward: code };
  return { pu: code };
}

// ---------------------------------------------------------------------------
// Register audit (evidence for INEC claims & objections)
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = {
  DUPLICATE_VIN_ACROSS_PUS: 'dupVin',
  POSSIBLE_DUPLICATE_REGISTRATION: 'possibleDup',
  BIRTH_YEAR_IMPLAUSIBLE: 'badBirthYear',
  ROWS_REJECTED: 'rejected',
  COUNT_MISMATCH: 'countMismatch',
} as const;

export interface AuditRow {
  code: string;
  name: string;
  records: number;
  dupVin: number;
  possibleDup: number;
  badBirthYear: number;
  rejected: number;
  countMismatch: number;
  total: number; // high-confidence findings (excludes name matches)
  per10k: number; // high-confidence findings per 10,000 records
}

/** Audit findings grouped by the level directly beneath `code` (LGA → wards, state → LGAs). */
export async function auditRows(c: Collections, code: string, scope: GeoScope, groupBy?: 'lga' | 'ward' | 'pu'): Promise<AuditRow[]> {
  const lvl = levelOf(code);
  const by = groupBy ?? (lvl === 'state' ? 'lga' : lvl === 'lga' ? 'ward' : 'pu');
  const issues = await c.issues
    .aggregate<{ _id: { k: string | null; cat: string }; affected: number }>([
      { $match: { ...scopeFilter(scope), ...underCode(code), category: { $in: Object.keys(AUDIT_CATEGORIES) }, status: { $in: ['open', 'in_review'] } } },
      { $group: { _id: { k: `$${by}`, cat: '$category' }, affected: { $sum: '$affected' } } },
    ])
    .toArray();
  const areas = await c.agg.find({ level: by, ...(code === LAGOS_STATE_CODE ? {} : { _id: { $regex: '^' + esc(code) + '-' } }) }).sort({ _id: 1 }).toArray();
  const rows = new Map<string, AuditRow>(
    areas.map((a) => [a._id, { code: a._id, name: a.name, records: a.records, dupVin: 0, possibleDup: 0, badBirthYear: 0, rejected: 0, countMismatch: 0, total: 0, per10k: 0 }]),
  );
  for (const i of issues) {
    // Ward-level issues (possible duplicates) have no PU; attribute them at ward/LGA level only.
    if (!i._id.k) continue;
    const r = rows.get(i._id.k);
    if (!r) continue;
    const key = AUDIT_CATEGORIES[i._id.cat as keyof typeof AUDIT_CATEGORIES];
    r[key] += i.affected;
  }
  for (const r of rows.values()) {
    // Name + birth-year matches are low confidence (common names collide) and are reported separately.
    r.total = r.dupVin + r.badBirthYear + r.rejected + r.countMismatch;
    r.per10k = r.records ? Math.round((r.total / r.records) * 100000) / 10 : 0;
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------------------
// Field operations planner
// ---------------------------------------------------------------------------

export interface PlanAssumptions {
  /** Voters per polling unit above which extra agents are planned. */
  threshold: number;
  /** One extra agent for every N voters above the threshold. */
  extraPer: number;
  /** Collation agents per ward. */
  wardAgents: number;
  /** Supervisors per LGA. */
  lgaSupervisors: number;
}
export const DEFAULT_ASSUMPTIONS: PlanAssumptions = { threshold: 750, extraPer: 500, wardAgents: 1, lgaSupervisors: 2 };

export interface PlanRow {
  code: string;
  name: string;
  wards: number;
  pus: number;
  voters: number;
  avgPerPu: number;
  largestPu: number;
  pusOverThreshold: number;
  puAgents: number;
  extraAgents: number;
  collationAgents: number;
  supervisors: number;
  totalAgents: number;
  youthShare: number; // 18-34 share of records with a known age
  seniorShare: number; // 65+
}

export async function planRows(c: Collections, code: string, a: PlanAssumptions): Promise<{ rows: PlanRow[]; totals: PlanRow }> {
  const lvl = levelOf(code);
  const by: 'lga' | 'ward' | 'pu' = lvl === 'state' ? 'lga' : lvl === 'lga' ? 'ward' : 'pu';
  const pus = await c.agg.find({ level: 'pu', ...(code === LAGOS_STATE_CODE ? {} : { _id: { $regex: '^' + esc(code) + '-' } }) }).toArray();
  const names = new Map((await c.agg.find({ level: by, ...(code === LAGOS_STATE_CODE ? {} : { _id: { $regex: '^' + esc(code) + '-' } }) }).toArray()).map((d) => [d._id, d.name]));
  const blank = (k: string, name: string): PlanRow & { _wards: Set<string>; _known: number; _youth: number; _senior: number } => ({
    code: k, name, wards: 0, pus: 0, voters: 0, avgPerPu: 0, largestPu: 0, pusOverThreshold: 0, puAgents: 0, extraAgents: 0, collationAgents: 0, supervisors: 0, totalAgents: 0, youthShare: 0, seniorShare: 0,
    _wards: new Set(), _known: 0, _youth: 0, _senior: 0,
  });
  const groups = new Map<string, ReturnType<typeof blank>>();
  const total = blank(code, 'TOTAL');
  const add = (g: ReturnType<typeof blank>, p: AggDoc) => {
    g.pus += 1;
    g.voters += p.records;
    g.largestPu = Math.max(g.largestPu, p.records);
    if (p.records > a.threshold) {
      g.pusOverThreshold += 1;
      g.extraAgents += Math.ceil((p.records - a.threshold) / a.extraPer);
    }
    if (p.ward) g._wards.add(p.ward);
    const b = p.ageBands ?? {};
    const known = (b['18-24'] ?? 0) + (b['25-34'] ?? 0) + (b['35-44'] ?? 0) + (b['45-54'] ?? 0) + (b['55-64'] ?? 0) + (b['65+'] ?? 0);
    g._known += known;
    g._youth += (b['18-24'] ?? 0) + (b['25-34'] ?? 0);
    g._senior += b['65+'] ?? 0;
  };
  for (const p of pus) {
    if (!p.records) continue;
    const k = by === 'lga' ? p.lga! : by === 'ward' ? p.ward! : p._id;
    if (!groups.has(k)) groups.set(k, blank(k, names.get(k) ?? k));
    add(groups.get(k)!, p);
    add(total, p);
  }
  const finish = (g: ReturnType<typeof blank>, lgaCount: number) => {
    g.wards = g._wards.size;
    g.avgPerPu = g.pus ? Math.round(g.voters / g.pus) : 0;
    g.puAgents = g.pus;
    g.collationAgents = g.wards * a.wardAgents;
    g.supervisors = lgaCount * a.lgaSupervisors;
    g.totalAgents = g.puAgents + g.extraAgents + g.collationAgents + g.supervisors;
    g.youthShare = g._known ? g._youth / g._known : 0;
    g.seniorShare = g._known ? g._senior / g._known : 0;
    const { _wards, _known, _youth, _senior, ...row } = g;
    void _wards; void _known; void _youth; void _senior;
    return row as PlanRow;
  };
  const rows = [...groups.values()].sort((x, y) => x.code.localeCompare(y.code)).map((g) => finish(g, by === 'lga' ? 1 : 0));
  const lgaCount = by === 'lga' ? groups.size : 1;
  return { rows, totals: finish(total, lgaCount) };
}

// ---------------------------------------------------------------------------
// Collation situation (war-room view)
// ---------------------------------------------------------------------------

export interface SituationLga {
  code: string;
  name: string;
  wards: number;
  approved: number;
  submitted: number;
  returned: number;
  draft: number;
  missing: number;
  reportedShare: number; // (approved + submitted) / wards
  incidents: number;
}

/** Settings for a time-driven election-day simulation (exercise ids starting with SIM-). */
export interface SimulationClock {
  startAt: Date;
  cycleMin: number; // the simulated day repeats on this cycle
  fillMin: number; // reports arrive during this part of the cycle; the rest holds the final picture
}

type SimSub = { ward: string; lga: string; status: string; values: Record<string, unknown>; updatedAt: Date; sim?: { s: number | null; r: number | null; f: string } };

/** Status of a simulated report at the current point of the cycle (null = not yet reported). */
export function simStatus(sim: NonNullable<SimSub['sim']>, elapsedSec: number): string | null {
  if (sim.s === null || elapsedSec < sim.s) return null;
  if (sim.r !== null && elapsedSec >= sim.r) return sim.f;
  return 'submitted';
}

export async function situation(c: Collections, exercise: string, scope: GeoScope) {
  const isSim = exercise.startsWith('SIM-');
  const clock = isSim ? ((await c.settings.findOne({ _id: 'simulation' }))?.value as SimulationClock | undefined) : undefined;
  const now = Date.now();
  const cycleSec = (clock?.cycleMin ?? 60) * 60;
  const elapsed = clock ? (((now - new Date(clock.startAt).getTime()) / 1000) % cycleSec + cycleSec) % cycleSec : 0;
  const [lgas, wards, rawSubs, recentAudit] = await Promise.all([
    c.geo.find({ level: 'lga', ...(scope.level === 'ward' ? { _id: { $in: [...new Set(scope.codes.map((w) => w.split('-').slice(0, 2).join('-')))] } } : scopeFilter(scope)) }).sort({ _id: 1 }).toArray(),
    c.geo.find({ level: 'ward', ...scopeFilter(scope) }).project<{ _id: string; lga: string; name: string }>({ lga: 1, name: 1 }).toArray(),
    c.submissions.find({ exercise, ...scopeFilter(scope) }).project<SimSub>({ ward: 1, lga: 1, status: 1, values: 1, updatedAt: 1, sim: 1 }).toArray(),
    isSim
      ? Promise.resolve([])
      : c.audit
          .find({ action: { $in: ['collation.submit', 'collation.approve', 'collation.return', 'collation.discrepancy'] }, ...(scope.level === 'state' ? {} : { target: { $regex: '^(' + scope.codes.map(esc).join('|') + ')' } }) })
          .sort({ at: -1 })
          .limit(15)
          .toArray(),
  ]);
  // In a simulation, each report's status depends on where we are in the cycle.
  const subs = isSim && clock
    ? rawSubs.flatMap((x) => {
        const st = x.sim ? simStatus(x.sim, elapsed) : x.status;
        return st ? [{ ...x, status: st }] : [];
      })
    : rawSubs;
  const byLga = new Map<string, SituationLga>(lgas.map((l) => [l._id, { code: l._id, name: l.name, wards: 0, approved: 0, submitted: 0, returned: 0, draft: 0, missing: 0, reportedShare: 0, incidents: 0 }]));
  for (const w of wards) {
    const r = byLga.get(w.lga);
    if (r) r.wards++;
  }
  const seen = new Set<string>();
  let agents = 0;
  let pusReported = 0;
  let pusTotal = 0;
  for (const s2 of subs) {
    const r = byLga.get(s2.lga);
    if (!r) continue;
    seen.add(s2.ward);
    if (s2.status === 'approved') r.approved++;
    else if (s2.status === 'submitted') r.submitted++;
    else if (s2.status === 'returned') r.returned++;
    else r.draft++;
    r.incidents += Number(s2.values?.incidents_count) || 0;
    agents += Number(s2.values?.agents_deployed) || 0;
    pusReported += Number(s2.values?.pus_reported) || 0;
    pusTotal += Number(s2.values?.pus_total) || 0;
  }
  for (const r of byLga.values()) {
    r.missing = r.wards - r.approved - r.submitted - r.returned - r.draft;
    r.reportedShare = r.wards ? (r.approved + r.submitted) / r.wards : 0;
  }
  const rows = [...byLga.values()];
  const sum = (k: keyof SituationLga) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const wardNames = new Map(wards.map((w) => [w._id, w.name]));
  const lgaNames = new Map(lgas.map((l) => [l._id, l.name]));

  let recent: { at: Date; action: string; ward: string; wardName: string; lga: string; by: string }[];
  if (isSim && clock) {
    const events: typeof recent = [];
    for (const x of rawSubs) {
      if (!x.sim || x.sim.s === null) continue;
      const push = (off: number, action: string) => {
        if (off <= elapsed) events.push({ at: new Date(Date.UTC(2027, 0, 1, 15, 0) + off * 8 * 1000), action, ward: x.ward, wardName: wardNames.get(x.ward) ?? x.ward, lga: lgaNames.get(x.lga) ?? x.lga, by: 'simulation' });
      };
      push(x.sim.s, 'submit');
      if (x.sim.r !== null) push(x.sim.r, x.sim.f === 'returned' ? 'return' : 'approve');
    }
    recent = events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 15); // simulated election-evening clock
  } else {
    recent = recentAudit.map((e) => ({ at: e.at, action: e.action.replace('collation.', ''), ward: e.target ?? '', wardName: wardNames.get(e.target ?? '') ?? e.target ?? '', lga: '', by: e.actorEmail ?? 'system' }));
  }
  return {
    exercise,
    simulation: isSim ? { cycleMin: clock?.cycleMin ?? 60, elapsedMin: Math.round(elapsed / 60), simulatedClock: clock ? new Date(Date.UTC(2027, 0, 1, 15, 0) + elapsed * 8 * 1000).toISOString() : null } : null,
    totals: { wards: sum('wards'), approved: sum('approved'), submitted: sum('submitted'), returned: sum('returned'), draft: sum('draft'), missing: sum('missing'), incidents: sum('incidents'), agents, pusReported, pusTotal },
    lgas: rows,
    missingWards: wards.filter((w) => !seen.has(w._id)).slice(0, 40).map((w) => ({ code: w._id, name: w.name, lga: byLga.get(w.lga)?.name ?? w.lga })),
    recent,
    asOf: new Date(),
  };
}
