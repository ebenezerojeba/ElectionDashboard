import { useState } from 'react';
import { ApiError, download, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Button, Card, ErrorState, Field, inputCls, LoadingBlock, PageHeader, StatusPill } from '../components/ui';

const DESCRIPTIONS: Record<string, string> = {
  'executive-summary': 'Headline figures for the selected area and each area beneath it, with metric definitions.',
  'geo-aggregate': 'Aggregate counts by area (children, or every ward / polling unit beneath the selection).',
  'data-quality': 'Issue counts by category, severity and status.',
  'import-jobs': 'Every import job with files, accepted and rejected rows, and peak memory.',
  reconciliation: 'Polling-unit reconciliation of register cover totals against stored and rejected rows.',
  'submission-status': 'Ward collation submission status, receipts and discrepancies.',
  'officer-activity': 'Collation actions per officer over the last 30 days (from the audit log).',
  'executive-brief': 'Designed one-page brief for leadership: headline figures, LGA chart, age profile, field operations and audit summary (PDF).',
  'register-audit': 'Possible register irregularities by area, prepared as evidence for INEC claims and objections.',
  'ops-plan': 'Field personnel deployment sheet by area, using the default planning assumptions.',
};

export function Reports() {
  const { me } = useAuth();
  const types = useApi<{ items: { id: string; title: string }[] }>('/api/reports');
  const stateWide = me?.user.scope.level === 'state';
  const lgas = useApi<{ children: { _id: string; name: string }[] }>(stateWide ? '/api/geo/node/24' : null);
  const roots = useApi<{ items: { _id: string; name: string }[] }>(stateWide ? null : '/api/geo/roots');
  const scopes = stateWide ? [{ _id: '24', name: 'Lagos State (all)' }, ...(lgas.data?.children ?? [])] : (roots.data?.items ?? []);
  const [scope, setScope] = useState('');
  const [level, setLevel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const history = useApi<{ recentExports: { _id: string; report: string; format: string; scope: string; at: string; rows: number; status: string; userEmail: string }[] }>('/api/stats/overview');
  const sel = scope || scopes[0]?._id || '';

  async function run(type: string, format: string) {
    setBusy(`${type}.${format}`);
    setErr(null);
    try {
      await download(`/api/reports/${type}?format=${format}&scope=${encodeURIComponent(sel)}${type === 'geo-aggregate' && level ? `&level=${level}` : ''}`);
      history.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="Reports & exports" subtitle="Every report states its generation time, period, scope, filters, source, validation status and limitations. Exports contain aggregates only and are recorded in the audit log." />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
          <Field label="Geographic scope" htmlFor="scope">
            <select id="scope" className={inputCls} value={sel} onChange={(e) => setScope(e.target.value)}>
              {scopes.map((s) => <option key={s._id} value={s._id}>{s.name} ({s._id})</option>)}
            </select>
          </Field>
          <Field label="Geographic aggregate detail" htmlFor="level" hint="Applies to the geographic aggregate report">
            <select id="level" className={inputCls} value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">Areas directly beneath the scope</option>
              <option value="ward">Every ward in scope</option>
              <option value="pu">Every polling unit in scope</option>
            </select>
          </Field>
        </div>
      </Card>
      {err && <p className="mt-3 text-sm text-critical" role="alert">{err}</p>}
      {types.error ? <div className="mt-4"><ErrorState error={types.error} /></div> : !types.data ? <div className="mt-4"><LoadingBlock /></div> : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {types.data.items.map((t) => (
            <div key={t.id} className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4">
              <div>
                <h2 className="text-sm font-semibold">{t.title}</h2>
                <p className="mt-1 text-sm text-ink-2">{DESCRIPTIONS[t.id]}</p>
              </div>
              <div className="mt-4 flex gap-2">
                {['pdf', 'xlsx', 'csv'].map((f) => (
                  <Button key={f} className="uppercase" disabled={!!busy} onClick={() => void run(t.id, f)}>
                    {busy === `${t.id}.${f}` ? '…' : f}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <Card className="mt-4" title="Export history" subtitle="Most recent exports visible to you" pad={false}>
        {!history.data ? <div className="p-5"><LoadingBlock rows={3} /></div> : history.data.recentExports.length === 0 ? <p className="p-5 text-sm text-ink-2">No exports yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {history.data.recentExports.map((e) => (
              <li key={e._id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                <span><span className="font-medium">{e.report}</span> <span className="uppercase text-muted">{e.format}</span> · scope {e.scope} · {e.rows} rows</span>
                <span className="flex items-center gap-2 text-xs text-muted">{e.userEmail} · {fmtDate(e.at)} <StatusPill status={e.status === 'generated' ? 'success' : 'denied'} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
