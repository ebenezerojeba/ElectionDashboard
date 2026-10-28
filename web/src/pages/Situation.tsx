import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInt } from '../lib/format';
import { ChoroplethMap, type MapFeatureCollection } from '../components/ChoroplethMap';

interface Lga { code: string; name: string; wards: number; approved: number; submitted: number; returned: number; draft: number; missing: number; reportedShare: number; incidents: number }
interface Sit {
  exercise: string;
  exerciseLabel: string;
  totals: { wards: number; approved: number; submitted: number; returned: number; draft: number; missing: number; incidents: number };
  lgas: Lga[];
  missingWards: { code: string; name: string; lga: string }[];
  recent: { at: string; action: string; ward: string; wardName: string; by: string }[];
  asOf: string;
}

const ACTION_LABEL: Record<string, string> = { submit: 'submitted', approve: 'approved', return: 'returned for correction', discrepancy: 'discrepancy flagged' };

/** Full-screen war-room display. Forces the dark theme while open; refreshes every 10 s. */
export function Situation() {
  const { settings } = useAuth();
  const sit = useApi<Sit>('/api/insights/situation');
  const [boundaries, setBoundaries] = useState<MapFeatureCollection | null>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    api<MapFeatureCollection>('/api/geo/boundaries?level=lga').then(setBoundaries).catch(() => {});
    const t1 = setInterval(() => void sit.reload(), 10_000);
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
  const reported = t ? t.approved + t.submitted : 0;
  const share = t?.wards ? reported / t.wards : 0;
  const lgasSorted = useMemo(() => [...(d?.lgas ?? [])].sort((a, b) => b.reportedShare - a.reportedShare || a.name.localeCompare(b.name)), [d]);

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--critical)] opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--critical)]" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Situation Room · Lagos collation</h1>
            <p className="text-xs text-ink-2">{d?.exerciseLabel ?? '…'} · internal reporting — not official results{settings?.dataset.synthetic ? ' · SYNTHETIC DEMONSTRATION DATA' : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <p className="tnum text-2xl font-semibold">{now.toLocaleTimeString('en-GB')}</p>
          <Link to="/" className="rounded-md border border-line-strong px-3 py-1.5 text-xs text-ink-2 hover:text-ink">Exit</Link>
        </div>
      </header>

      <div className="grid gap-4 p-5 xl:grid-cols-6">
        <div className="rounded-xl border border-line bg-surface p-5 xl:col-span-2">
          <p className="text-sm text-ink-2">Wards reported</p>
          <p className="mt-1 text-6xl font-semibold tracking-tight tnum">
            {t ? fmtInt(reported) : '—'}
            <span className="text-2xl text-muted"> / {t ? fmtInt(t.wards) : '—'}</span>
          </p>
          <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[var(--good)] transition-[width] duration-700" style={{ width: `${share * 100}%` }} />
          </div>
          <p className="mt-1.5 text-sm text-ink-2">{(share * 100).toFixed(1)}% of wards</p>
        </div>
        {[
          ['Approved', t?.approved, 'var(--good)'],
          ['Awaiting review', t?.submitted, 'var(--accent)'],
          ['Returned', t?.returned, 'var(--serious)'],
          ['Not yet reported', t ? t.missing + t.draft : undefined, 'var(--critical)'],
        ].map(([label, val, color]) => (
          <div key={String(label)} className="rounded-xl border border-line bg-surface p-5">
            <p className="flex items-center gap-2 text-sm text-ink-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: String(color) }} aria-hidden="true" />
              {label}
            </p>
            <p className="mt-2 text-5xl font-semibold tnum">{val === undefined ? '—' : fmtInt(val as number)}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 px-5 pb-5 xl:grid-cols-[1.35fr_1fr]">
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold">Reporting progress by LGA</h2>
          {boundaries && d ? (
            <ChoroplethMap boundaries={boundaries} values={Object.fromEntries(d.lgas.map((l) => [l.code, Math.round(l.reportedShare * 100)]))} names={Object.fromEntries(d.lgas.map((l) => [l.code, l.name]))} metricLabel="% of wards reported" />
          ) : (
            <div className="skeleton h-[360px]" />
          )}
        </section>
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold">LGAs</h2>
          <ul className="max-h-[400px] space-y-1.5 overflow-y-auto pr-1">
            {lgasSorted.map((l) => (
              <li key={l.code} className="grid grid-cols-[minmax(110px,38%)_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate text-ink-2">{l.name}</span>
                <span className="flex h-3 gap-[2px] overflow-hidden rounded-sm bg-surface-2" aria-hidden="true">
                  <span className="bg-[var(--good)]" style={{ width: `${(l.approved / (l.wards || 1)) * 100}%` }} />
                  <span className="bg-[var(--accent)]" style={{ width: `${(l.submitted / (l.wards || 1)) * 100}%` }} />
                  <span className="bg-[var(--serious)]" style={{ width: `${(l.returned / (l.wards || 1)) * 100}%` }} />
                </span>
                <span className="tnum w-16 text-right text-xs">
                  <span className="font-semibold text-ink">{l.approved + l.submitted}</span>/{l.wards}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex flex-wrap gap-4 text-[11px] text-ink-2">
            <span>■ <span className="text-good-ink">Approved</span></span>
            <span><span style={{ color: 'var(--accent)' }}>■</span> Awaiting review</span>
            <span><span style={{ color: 'var(--serious)' }}>■</span> Returned</span>
          </p>
        </section>
      </div>

      <div className="grid gap-4 px-5 pb-6 xl:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold">Live activity</h2>
          {d?.recent.length ? (
            <ol className="space-y-2">
              {d.recent.map((e, i) => (
                <li key={i} className="flex items-baseline gap-3 text-sm">
                  <span className="tnum w-16 shrink-0 text-xs text-muted">{new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span>
                    <span className="font-medium">{e.wardName}</span> <span className="text-ink-2">{ACTION_LABEL[e.action] ?? e.action}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-ink-2">No ward activity yet.</p>
          )}
        </section>
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold">
            Wards not yet reported <span className="tnum font-normal text-muted">({t ? fmtInt(t.missing) : '—'})</span>
          </h2>
          <ul className="grid max-h-64 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto text-sm sm:grid-cols-2">
            {d?.missingWards.map((w) => (
              <li key={w.code} className="truncate">
                <span className="tnum text-xs text-muted">{w.code}</span> {w.name} <span className="text-xs text-muted">· {w.lga}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="px-6 pb-4 text-right text-[11px] text-muted">Updates every 10 seconds · as of {d ? new Date(d.asOf).toLocaleTimeString('en-GB') : '—'}</p>
    </div>
  );
}
