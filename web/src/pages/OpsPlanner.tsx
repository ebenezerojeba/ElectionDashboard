import { useEffect, useState } from 'react';
import { ApiError, download, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInt } from '../lib/format';
import { Button, Card, ErrorState, Field, LoadingBlock, PageHeader, StatTile, inputCls } from '../components/ui';
import { DataTable } from '../components/DataTable';
import { BarList } from '../components/charts';
import { ScopePicker } from '../components/ScopePicker';

interface Row { code: string; name: string; wards: number; pus: number; voters: number; avgPerPu: number; largestPu: number; pusOverThreshold: number; puAgents: number; extraAgents: number; collationAgents: number; supervisors: number; totalAgents: number; youthShare: number; seniorShare: number; [k: string]: unknown }
interface Resp { assumptions: Assumptions; rows: Row[]; totals: Row }
interface Assumptions { threshold: number; extraPer: number; wardAgents: number; lgaSupervisors: number }

export function OpsPlanner() {
  const { can } = useAuth();
  const [scope, setScope] = useState('');
  const [a, setA] = useState<Assumptions>({ threshold: 750, extraPer: 500, wardAgents: 1, lgaSupervisors: 2 });
  const [applied, setApplied] = useState(a);
  useEffect(() => {
    const t = setTimeout(() => setApplied(a), 400);
    return () => clearTimeout(t);
  }, [a]);
  const qs = `scope=${scope}&threshold=${applied.threshold}&extraPer=${applied.extraPer}&wardAgents=${applied.wardAgents}&lgaSupervisors=${applied.lgaSupervisors}`;
  const d = useApi<Resp>(scope ? `/api/insights/plan?${qs}` : null, [qs]);
  const [err, setErr] = useState<string | null>(null);
  const t = d.data?.totals;
  const set = (k: keyof Assumptions, v: string) => setA((x) => ({ ...x, [k]: Number(v.replace(/\D/g, '')) || 0 }));

  return (
    <div>
      <PageHeader
        title="Field operations planner"
        subtitle="Personnel planning from polling-unit sizes in the validated register. Adjust the assumptions to party deployment policy; figures update instantly."
        actions={
          <>
            <ScopePicker value={scope} onChange={setScope} />
            {can('reports.export') &&
              ['xlsx', 'pdf', 'csv'].map((f) => (
                <Button key={f} className="uppercase" onClick={() => download(`/api/reports/ops-plan?format=${f}&${qs}`).catch((e) => setErr(e instanceof ApiError ? e.message : 'Export failed'))}>
                  {f}
                </Button>
              ))}
          </>
        }
      />
      {err && <p className="mb-3 text-sm text-critical">{err}</p>}
      <Card title="Assumptions">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Large polling unit above (voters)" htmlFor="th" hint="PUs above this get extra agents">
            <input id="th" inputMode="numeric" className={inputCls + ' tnum'} value={a.threshold} onChange={(e) => set('threshold', e.target.value)} />
          </Field>
          <Field label="One extra agent per (voters above)" htmlFor="ep">
            <input id="ep" inputMode="numeric" className={inputCls + ' tnum'} value={a.extraPer} onChange={(e) => set('extraPer', e.target.value)} />
          </Field>
          <Field label="Collation agents per ward" htmlFor="wa">
            <input id="wa" inputMode="numeric" className={inputCls + ' tnum'} value={a.wardAgents} onChange={(e) => set('wardAgents', e.target.value)} />
          </Field>
          <Field label="Supervisors per LGA" htmlFor="ls">
            <input id="ls" inputMode="numeric" className={inputCls + ' tnum'} value={a.lgaSupervisors} onChange={(e) => set('lgaSupervisors', e.target.value)} />
          </Field>
        </div>
      </Card>
      {d.error ? <div className="mt-4"><ErrorState error={d.error} onRetry={d.reload} /></div> : !d.data || !t ? <div className="mt-4"><LoadingBlock rows={6} /></div> : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile emphasis label="Total field personnel" value={fmtInt(t.totalAgents)} note={`${fmtInt(t.puAgents)} PU · ${fmtInt(t.extraAgents)} extra · ${fmtInt(t.collationAgents)} collation · ${fmtInt(t.supervisors)} supervisors`} definition="One agent per polling unit, extra agents for large polling units, collation agents per ward and supervisors per LGA, using the assumptions above." />
            <StatTile label="Polling units to cover" value={fmtInt(t.pus)} note={`${fmtInt(t.wards)} wards · ${fmtInt(t.voters)} voters`} />
            <StatTile label={`Large polling units (> ${fmtInt(d.data.assumptions.threshold)})`} value={fmtInt(t.pusOverThreshold)} note={`Largest: ${fmtInt(t.largestPu)} voters · average ${fmtInt(t.avgPerPu)}`} definition="Polling units whose validated voter count exceeds the threshold; expect longer queues and plan extra agents." />
            <StatTile label="Youth share (18–34)" value={`${(t.youthShare * 100).toFixed(1)}%`} note={`65+: ${(t.seniorShare * 100).toFixed(1)}% · of voters with a known age`} definition="Aggregate age composition for outreach planning. Based on birth year relative to the register print year." />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.6fr]">
            <Card title="Personnel needed by area">
              <BarList valueLabel="Personnel" items={[...d.data.rows].sort((x, y) => y.totalAgents - x.totalAgents).slice(0, 20).map((r) => ({ key: r.code, label: r.name, value: r.totalAgents, sub: `${fmtInt(r.pus)} PUs · ${fmtInt(r.pusOverThreshold)} large` }))} onSelect={(c) => c.split('-').length < 3 && setScope(c)} />
            </Card>
            <Card title="Deployment sheet" subtitle="Select an LGA row to plan its wards" pad={false}>
              <DataTable
                rows={d.data.rows}
                rowKey={(r) => r.code}
                onRowClick={(r) => r.code.split('-').length < 3 && setScope(r.code)}
                columns={[
                  { key: 'name', label: 'Area', render: (r) => <div><p className="font-medium">{r.name}</p><p className="tnum text-xs text-muted">{r.code}</p></div> },
                  { key: 'pus', label: 'PUs', numeric: true, render: (r) => fmtInt(r.pus) },
                  { key: 'voters', label: 'Voters', numeric: true, render: (r) => fmtInt(r.voters) },
                  { key: 'avgPerPu', label: 'Avg/PU', numeric: true, render: (r) => fmtInt(r.avgPerPu) },
                  { key: 'pusOverThreshold', label: 'Large PUs', numeric: true, render: (r) => fmtInt(r.pusOverThreshold) },
                  { key: 'totalAgents', label: 'Personnel', numeric: true, render: (r) => <span className="font-semibold">{fmtInt(r.totalAgents)}</span> },
                  { key: 'youthShare', label: 'Youth', numeric: true, render: (r) => `${(r.youthShare * 100).toFixed(0)}%` },
                ]}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
