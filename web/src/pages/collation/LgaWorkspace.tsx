import { useEffect, useState } from 'react';
import { api, ApiError, download, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtInt } from '../../lib/format';
import { Button, Card, ErrorState, Field, inputCls, smallSelect, fieldCls, LoadingBlock, Modal, Notice, PageHeader, StatusPill } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { History, ValuesTable, type Context, type Submission } from './shared';

interface LgaStatus {
  lga: string;
  exercise: string;
  wards: { ward: string; name: string; status: string; submissionId: string | null; submittedAt: string | null; discrepancies: number; values: Record<string, number | string | null> | null; [k: string]: unknown }[];
  counts: Record<string, number>;
  consolidated: { approvedOnly: Record<string, number>; approvedAndPending: Record<string, number> };
  canReview: boolean;
}

export function LgaWorkspace() {
  const { me, can } = useAuth();
  const scoped = me?.user.scope.level === 'lga' ? me.user.scope.codes : null;
  const lgaList = useApi<{ children: { _id: string; name: string }[] }>(scoped ? null : '/api/geo/node/24');
  const roots = useApi<{ items: { _id: string; name: string }[] }>(scoped ? '/api/geo/roots' : null);
  const options = scoped ? (roots.data?.items ?? scoped.map((c) => ({ _id: c, name: c }))) : (lgaList.data?.children ?? []);
  const [lga, setLga] = useState<string>(scoped?.[0] ?? '');
  useEffect(() => {
    if (!lga && options[0]) setLga(options[0]._id);
  }, [options, lga]);
  const ctx = useApi<Context>('/api/collation/context');
  const st = useApi<LgaStatus>(lga ? `/api/collation/lga/${lga}/status` : null, [lga]);
  const [open, setOpen] = useState<string | null>(null);
  const [expErr, setExpErr] = useState<string | null>(null);
  const t = ctx.data?.templates[0];
  const numericFields = t?.fields.filter((f) => f.type === 'integer') ?? [];

  if (me?.user.scope.level === 'ward') return <Notice>This workspace is for LGA-level users.</Notice>;

  return (
    <div>
      <PageHeader
        title="LGA workspace"
        subtitle={ctx.data?.exercise.label}
        actions={
          <>
            <label className="sr-only" htmlFor="lga">LGA</label>
            <select id="lga" className={fieldCls('w-56')} value={lga} onChange={(e) => setLga(e.target.value)}>
              {options.map((o) => <option key={o._id} value={o._id}>{o.name}</option>)}
            </select>
            {can('reports.export') &&
              ['xlsx', 'pdf', 'csv'].map((f) => (
                <Button key={f} className="uppercase" onClick={() => download(`/api/reports/submission-status?format=${f}&scope=${lga}`).catch((e) => setExpErr(e instanceof ApiError ? e.message : 'Export failed'))}>
                  {f}
                </Button>
              ))}
          </>
        }
      />
      <Notice tone="warn">{ctx.data?.notice ?? 'Internal reporting only.'}</Notice>
      {expErr && <p className="mt-2 text-sm text-critical">{expErr}</p>}
      {st.error ? (
        <div className="mt-4"><ErrorState error={st.error} onRetry={st.reload} /></div>
      ) : !st.data ? (
        <div className="mt-4"><LoadingBlock rows={8} /></div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(['approved', 'submitted', 'returned', 'draft', 'missing'] as const).map((k) => (
              <div key={k} className="rounded-xl border border-line bg-surface p-3">
                <StatusPill status={k} />
                <p className="mt-2 text-2xl font-semibold tnum">{fmtInt(st.data!.counts[k] ?? 0)}</p>
                <p className="text-xs text-muted">of {st.data!.wards.length} wards</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
            <Card title="Ward submissions" subtitle="Select a ward to review" pad={false}>
              <DataTable
                rows={st.data.wards}
                rowKey={(r) => r.ward}
                onRowClick={(r) => r.submissionId && setOpen(r.submissionId)}
                columns={[
                  { key: 'ward', label: 'Code', className: 'tnum text-xs text-ink-2' },
                  { key: 'name', label: 'Ward', render: (r) => <span className="font-medium">{r.name}</span> },
                  { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
                  { key: 'submittedAt', label: 'Submitted', render: (r) => <span className="text-xs">{r.submittedAt ? fmtDate(r.submittedAt) : '—'}</span> },
                  { key: 'discrepancies', label: 'Discrepancies', numeric: true, render: (r) => (r.discrepancies ? <span className="font-semibold text-critical">▲ {r.discrepancies}</span> : '0') },
                  { key: 'pus_reported', label: 'PUs reporting', numeric: true, render: (r) => (r.values ? `${r.values.pus_reported ?? '—'} / ${r.values.pus_total ?? '—'}` : '—') },
                ]}
              />
            </Card>
            <Card title="Consolidated totals" subtitle="Sum across ward reports">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted"><th className="py-1 text-left font-medium">Field</th><th className="py-1 text-right font-medium">Approved</th><th className="py-1 text-right font-medium">+ Pending</th></tr>
                </thead>
                <tbody>
                  {numericFields.map((f) => (
                    <tr key={f.key} className="border-t border-line">
                      <td className="py-1.5 text-ink-2">{f.label}</td>
                      <td className="tnum py-1.5 text-right font-medium">{fmtInt(st.data!.consolidated.approvedOnly[f.key] ?? 0)}</td>
                      <td className="tnum py-1.5 text-right text-ink-2">{fmtInt(st.data!.consolidated.approvedAndPending[f.key] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted">Missing wards are not estimated. Approved figures exclude reports awaiting review.</p>
            </Card>
          </div>
        </>
      )}
      <Modal title="Ward report" open={!!open} onClose={() => setOpen(null)} wide>
        {open && t && <Review id={open} t={t} canReview={!!st.data?.canReview} onDone={() => { st.reload(); }} />}
      </Modal>
    </div>
  );
}

function Review({ id, t, canReview, onDone }: { id: string; t: NonNullable<Context['templates'][0]>; canReview: boolean; onDone: () => void }) {
  const s = useApi<Submission>(`/api/collation/submissions/${id}`, [id]);
  const [note, setNote] = useState('');
  const [field, setField] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (s.error) return <ErrorState error={s.error} />;
  if (!s.data) return <LoadingBlock />;
  const sub = s.data;
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/collation/submissions/${id}/${path}`, { body });
      setNote('');
      setField('');
      s.reload();
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatusPill status={sub.status} />
        <span className="tnum">Ward {sub.ward}</span>
        {sub.receiptNo && <span className="font-mono text-xs text-muted">{sub.receiptNo}</span>}
      </div>
      <ValuesTable t={t} values={sub.values} discrepancies={sub.discrepancies} />
      {canReview && sub.status === 'submitted' && (
        <div className="space-y-3 rounded-lg border border-line p-4">
          <p className="text-sm font-medium">Review</p>
          <Field label="Note" htmlFor="rnote" hint="Required when returning or flagging a discrepancy">
            <textarea id="rnote" rows={2} className={inputCls + ' h-auto py-2'} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void act('approve', { note: note || undefined })}>Approve</Button>
            <Button disabled={busy || note.trim().length < 5} onClick={() => void act('return', { note })}>Return for correction</Button>
            <span className="mx-1 h-6 w-px bg-line" />
            <select aria-label="Field with discrepancy" className={fieldCls('w-48')} value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">Field…</option>
              {t.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <Button disabled={busy || !field || note.trim().length < 5} onClick={() => void act('discrepancy', { field, note })}>Flag discrepancy</Button>
          </div>
          {err && <p className="text-sm text-critical" role="alert">{err}</p>}
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-medium text-muted">History</p>
        <History items={sub.history} />
      </div>
    </div>
  );
}
