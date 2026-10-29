import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInt } from '../lib/format';
import { ChoroplethMap, type MapFeatureCollection } from '../components/ChoroplethMap';

interface Lga { code: string; name: string; wards: number; approved: number; submitted: number; returned: number; draft: number; missing: number; reportedShare: number; incidents: number }
interface Sit {
  exercise: string;
  exerciseLabel: string;
  simulation: { cycleMin: number; elapsedMin: number; simulatedClock: string | null } | null;
  totals: { wards: number; approved: number; submitted: number; returned: number; draft: number; missing: number; incidents: number; agents: number; pusReported: number; pusTotal: number };
  lgas: Lga[];
  missingWards: { code: string; name: string; lga: string }[];
  recent: { at: string; action: string; ward: string; wardName: string; lga?: string; by: string }[];
  asOf: string;
}

const ACTION: Record<string, { label: string; color: string }> = {
  submit: { label: 'reported', color: 'var(--accent)' },
  approve: { label: 'approved by LGA', color: 'var(--good)' },
  return: { label: 'returned for correction', color: 'var(--serious)' },
  discrepancy: { label: 'discrepancy flagged', color: 'var(--warning)' },
};
const tc = (s: string) => s.toLowerCase().replace(/(^|[\s/-])\S/g, (c) => c.toUpperCase());

/** Full-screen war-room display. Forces the dark theme while open; refreshes every 8 s. */
export function Situation() {
  const { settings } = useAuth();
  const sit = useApi<Sit>('/api/insights/situation');
  const [boundaries, setBoundaries] = useState<MapFeatureCollection | null>(null);
  const [now, setNow] = useState(new Date());
  const lastTop = useRef<string>('');
  const [fresh, setFresh] = useState<string>('');
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    api<MapFeatureCollection>('/api/geo/boundaries?level=lga').then(setBoundaries).catch(() => {});
    const t1 = setInterval(() => void sit.reload(), 8_000);
    const t2 = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      if (prev) root.setAttribute('data-theme', prev);
      else root.removeAttribute('data-theme');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const d = sit.data;
  const t = d?.totals;
  // Highlight the newest event when it changes.
  useEffect(() => {
    const top = d?.recent[0] ? `${d.recent[0].ward}-${d.recent[0].action}` : '';
    if (top && top !== lastTop.current) {
      if (lastTop.current) setFresh(top);
      lastTop.current = top;
    }
  }, [d]);
  const reported = t ? t.approved + t.submitted : 0;
  const share = t?.wards ? reported / t.wards : 0;
  const lgasSorted = useMemo(() => [...(d?.lgas ?? [])].sort((a, b) => b.reportedShare - a.reportedShare || a.name.localeCompare(b.name)), [d]);
  const isSim = !!d?.simulation;
  const clock = d?.simulation?.simulatedClock ? new Date(d.simulation.simulatedClock).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : now.toLocaleTimeString('en-GB');

  return (
    <div className="min-h-screen bg-[#08141a] text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#0b1d24] px-6 py-3.5">
        <div className="flex items-center gap-3.5">
          <span className="relative flex h-3 w-3" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--critical)] opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--critical)]" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold text-white">Lagos situation room</h1>
              {isSim && <span className="rounded-full bg-[var(--ochre)] px-2.5 py-0.5 text-[11.5px] font-bold text-[#1b1206]">Simulation · illustrative data</span>}
            </div>
            <p className="text-[12.5px] text-[#9fb3ba]">
              Ward collation progress{isSim ? ' — not real results' : ''}{settings?.dataset.synthetic ? ' · synthetic demonstration data' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="text-right">
            <p className="tnum text-3xl font-bold leading-none text-white">{clock}</p>
            <p className="mt-1 text-[11.5px] text-[#9fb3ba]">{isSim ? 'Simulated time, election evening' : 'Local time'}</p>
          </div>
          <Link to="/" className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-[#d7e4e8] hover:bg-white/10">Exit</Link>
        </div>
      </header>

      <div className="grid gap-4 p-5 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-[#0e2229] p-5">
          <p className="text-sm text-[#9fb3ba]">Wards reported</p>
          <p className="tnum mt-1 text-6xl font-extrabold tracking-tight text-white">
            {t ? fmtInt(reported) : '—'}
            <span className="text-2xl font-semibold text-[#6f8a93]"> of {t ? fmtInt(t.wards) : '—'}</span>
          </p>
          <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[linear-gradient(90deg,#2f8a5a,#66b483)] transition-[width] duration-700" style={{ width: `${share * 100}%` }} />
          </div>
          <p className="tnum mt-2 text-sm text-[#c9d6da]">{(share * 100).toFixed(1)}% of Lagos wards</p>
        </div>
        {[
          ['Approved by LGA', t?.approved, 'var(--good)', null],
          ['Awaiting review', t?.submitted, 'var(--accent)', null],
          ['Returned', t?.returned, 'var(--serious)', null],
          ['Not yet reported', t ? t.missing + t.draft : undefined, 'var(--critical)', null],
        ].map(([label, val, color]) => (
          <div key={String(label)} className="rounded-2xl border border-white/10 bg-[#0e2229] p-5">
            <p className="flex items-center gap-2 text-sm text-[#9fb3ba]">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: String(color) }} aria-hidden="true" />
              {label}
            </p>
            <p className="tnum mt-2 text-5xl font-bold text-white">{val === undefined ? '—' : fmtInt(val as number)}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 px-5 sm:grid-cols-3">
        {[
          ['Polling units covered', t ? `${fmtInt(t.pusReported)}` : '—', t?.pusTotal ? `of ${fmtInt(t.pusTotal)} in reporting wards` : ''],
          ['Party agents on duty', t ? fmtInt(t.agents) : '—', 'across reporting wards'],
          ['Incidents logged', t ? fmtInt(t.incidents) : '—', 'reported by ward officers'],
        ].map(([label, val, note]) => (
          <div key={label} className="flex items-baseline justify-between rounded-2xl border border-white/10 bg-[#0b1d24] px-5 py-3.5">
            <span className="text-sm text-[#9fb3ba]">{label}</span>
            <span className="text-right">
              <span className="tnum text-2xl font-bold text-white">{val}</span>
              <span className="ml-2 text-xs text-[#6f8a93]">{note}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="grid gap-4 p-5 xl:grid-cols-[1.45fr_1fr]">
        <section className="rounded-2xl border border-white/10 bg-[#0e2229] p-4">
          <h2 className="mb-3 text-[15px] font-semibold text-white">Reporting progress by LGA</h2>
          {boundaries && d ? (
            <ChoroplethMap
              height={420}
              unit="%"
              boundaries={boundaries}
              values={Object.fromEntries(d.lgas.map((l) => [l.code, Math.round(l.reportedShare * 100)]))}
              names={Object.fromEntries(d.lgas.map((l) => [l.code, l.name]))}
              metricLabel="Wards reported"
              zeroIsData
            />
          ) : (
            <div className="skeleton h-[420px]" />
          )}
        </section>
        <section className="rounded-2xl border border-white/10 bg-[#0e2229] p-4">
          <h2 className="mb-3 text-[15px] font-semibold text-white">LGAs</h2>
          <ul className="max-h-[470px] space-y-2 overflow-y-auto pr-1">
            {lgasSorted.map((l) => (
              <li key={l.code} className="grid grid-cols-[minmax(110px,38%)_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate text-[#c9d6da]">{tc(l.name)}</span>
                <span className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-white/10" aria-hidden="true">
                  <span className="bg-[var(--good)]" style={{ width: `${(l.approved / (l.wards || 1)) * 100}%` }} />
                  <span className="bg-[var(--accent)]" style={{ width: `${(l.submitted / (l.wards || 1)) * 100}%` }} />
                  <span className="bg-[var(--serious)]" style={{ width: `${(l.returned / (l.wards || 1)) * 100}%` }} />
                </span>
                <span className="tnum w-14 text-right text-xs text-[#9fb3ba]">
                  <span className="font-semibold text-white">{l.approved + l.submitted}</span>/{l.wards}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex flex-wrap gap-4 text-[11.5px] text-[#9fb3ba]">
            {[['Approved', 'var(--good)'], ['Awaiting review', 'var(--accent)'], ['Returned', 'var(--serious)']].map(([l, c]) => (
              <span key={l} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</span>
            ))}
          </p>
        </section>
      </div>

      <div className="grid gap-4 px-5 pb-6 xl:grid-cols-2">
        <section className="rounded-2xl border border-white/10 bg-[#0e2229] p-4">
          <h2 className="mb-3 text-[15px] font-semibold text-white">Live activity</h2>
          {d?.recent.length ? (
            <ol className="space-y-1">
              {d.recent.map((e, i) => {
                const a = ACTION[e.action] ?? { label: e.action, color: 'var(--muted)' };
                const isFresh = i === 0 && fresh === `${e.ward}-${e.action}`;
                return (
                  <li key={`${e.ward}-${e.action}-${i}`} className={'flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-1000 ' + (isFresh ? 'bg-white/10' : '')}>
                    <span className="tnum w-12 shrink-0 text-xs text-[#6f8a93]">{new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(isSim ? { timeZone: 'UTC' } : {}) })}</span>
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: a.color }} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="font-semibold text-white">{tc(e.wardName)}</span>
                      {e.lga && <span className="text-[#6f8a93]"> · {tc(e.lga)}</span>}
                      <span className="text-[#c9d6da]"> {a.label}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-[#9fb3ba]">No ward has reported yet.</p>
          )}
        </section>
        <section className="rounded-2xl border border-white/10 bg-[#0e2229] p-4">
          <h2 className="mb-3 text-[15px] font-semibold text-white">
            Wards not yet reported <span className="tnum font-normal text-[#6f8a93]">({t ? fmtInt(t.missing + t.draft) : '—'})</span>
          </h2>
          <ul className="grid max-h-72 grid-cols-1 gap-x-4 gap-y-1.5 overflow-y-auto text-sm sm:grid-cols-2">
            {d?.missingWards.map((w) => (
              <li key={w.code} className="truncate text-[#c9d6da]">
                {tc(w.name)} <span className="text-xs text-[#6f8a93]">· {tc(w.lga)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="px-6 pb-4 text-right text-[11px] text-[#6f8a93]">
        Updates every 8 seconds{isSim ? ` · the simulated evening replays every ${d?.simulation?.cycleMin} minutes` : ''}
      </p>
    </div>
  );
}
