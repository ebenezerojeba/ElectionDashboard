import { useEffect, useState } from 'react';
import { api, ApiError, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/format';
import { Button, Card, ErrorState, Field, inputCls, LoadingBlock, Modal, Notice, PageHeader, StatusPill } from '../../components/ui';
import { History, type Context, type Submission, type Template } from './shared';

export function WardWorkspace() {
  const { me } = useAuth();
  const wards = me?.user.scope.level === 'ward' ? me.user.scope.codes : [];
  const ctx = useApi<Context>('/api/collation/context');
  const subs = useApi<{ items: Submission[] }>('/api/collation/submissions?limit=100');
  const [ward, setWard] = useState<string>(wards[0] ?? '');
  const names = useApi<{ items: { _id: string; name: string }[] }>('/api/geo/roots');

  if (!wards.length) return <Notice>This workspace is for Ward Collation Officers assigned to specific wards.</Notice>;
  if (ctx.error) return <ErrorState error={ctx.error} onRetry={ctx.reload} />;
  const sub = subs.data?.items.find((s) => s.ward === ward && s.exercise === ctx.data?.exercise.id);
  const t = ctx.data?.templates[0];

  return (
    <div>
      <PageHeader title="Ward workspace" subtitle={ctx.data ? `${ctx.data.exercise.label}` : 'Loading…'} />
      <Notice tone="warn">{ctx.data?.notice ?? 'Internal reporting only.'}</Notice>
      <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card title="My wards" pad={false}>
          <ul className="divide-y divide-line">
            {wards.map((w) => {
              const s = subs.data?.items.find((x) => x.ward === w);
              return (
                <li key={w}>
                  <button onClick={() => setWard(w)} aria-current={ward === w} className={'flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-surface-2 ' + (ward === w ? 'bg-brand-soft' : '')}>
                    <span>
                      <span className="block text-sm font-medium">{names.data?.items.find((n) => n._id === w)?.name ?? w}</span>
                      <span className="tnum text-xs text-muted">{w}</span>
                    </span>
                    <StatusPill status={s?.status ?? 'missing'} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
        {!t || !subs.data ? (
          <LoadingBlock rows={6} />
        ) : (
          <WardReport key={ward + (sub?._id ?? '')} ward={ward} t={t} sub={sub ?? null} onChange={subs.reload} />
        )}
      </div>
    </div>
  );
}

function WardReport({ ward, t, sub, onChange }: { ward: string; t: Template; sub: Submission | null; onChange: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ receiptNo: string; submittedAt: string; ward: string; exercise: string; submittedBy: string } | null>(null);
  useEffect(() => {
    setValues(Object.fromEntries(t.fields.map((f) => [f.key, sub?.values[f.key] === null || sub?.values[f.key] === undefined ? '' : String(sub.values[f.key])])));
    setErrors({});
  }, [sub, t]);

  const editable = !sub || sub.status === 'draft' || sub.status === 'returned';
  const lastReturn = sub?.status === 'returned' ? [...sub.history].reverse().find((h) => h.action === 'returned') : null;

  async function start() {
    setBusy(true);
    try {
      await api('/api/collation/submissions', { body: { ward } });
      onChange();
    } catch (e) {
      setMsg({ tone: 'warn', text: e instanceof ApiError ? e.message : 'Could not start the report' });
    } finally {
      setBusy(false);
    }
  }
  const payload = () => Object.fromEntries(t.fields.map((f) => [f.key, values[f.key] === '' ? null : f.type === 'integer' ? Number(values[f.key]) : values[f.key]!]));
  async function save(): Promise<boolean> {
    if (!sub) return false;
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/collation/submissions/${sub._id}`, { method: 'PATCH', body: { version: sub.version, values: payload() } });
      setErrors({});
      setMsg({ tone: 'info', text: 'Draft saved.' });
      onChange();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      setMsg({ tone: 'warn', text: e instanceof ApiError ? e.message : 'Save failed' });
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!sub) return;
    setBusy(true);
    setMsg(null);
    try {
      const saved = await api<Submission>(`/api/collation/submissions/${sub._id}`, { method: 'PATCH', body: { version: sub.version, values: payload() } });
      const r = await api<{ receipt: NonNullable<typeof receipt> }>(`/api/collation/submissions/${saved._id}/submit`, { method: 'POST' });
      setReceipt(r.receipt);
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      setMsg({ tone: 'warn', text: e instanceof ApiError ? e.message : 'Submit failed' });
      onChange();
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (!sub) return;
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    try {
      await api(`/api/collation/submissions/${sub._id}/attachments`, { form });
      setMsg({ tone: 'info', text: 'Document uploaded to private storage.' });
      onChange();
    } catch (e) {
      setMsg({ tone: 'warn', text: e instanceof ApiError ? e.message : 'Upload failed' });
    } finally {
      setBusy(false);
    }
  }
  async function openAttachment(n: number) {
    if (!sub) return;
    try {
      const r = await api<{ url: string }>(`/api/collation/submissions/${sub._id}/attachments/${n}`);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setMsg({ tone: 'warn', text: e instanceof ApiError ? e.message : 'Could not open document' });
    }
  }

  if (!sub)
    return (
      <Card title={t.name} subtitle={t.description}>
        <p className="text-sm text-ink-2">No report has been started for this ward in the current exercise.</p>
        <Button variant="primary" className="mt-4" disabled={busy} onClick={() => void start()}>
          Start ward report
        </Button>
        {msg && <p className="mt-2 text-sm text-critical">{msg.text}</p>}
      </Card>
    );

  return (
    <div className="space-y-4">
      {lastReturn && (
        <Notice tone="warn">
          <p className="font-medium">Returned for correction by {lastReturn.by}</p>
          <p className="mt-0.5">“{lastReturn.note}”</p>
          {sub.discrepancies?.map((d, i) => (
            <p key={i} className="mt-1 text-xs">▲ {d.field}: {d.note}</p>
          ))}
        </Notice>
      )}
      <Card
        title={t.name}
        subtitle={<>Ward <span className="tnum">{ward}</span> · version {sub.version}{sub.receiptNo && <> · receipt <span className="font-mono">{sub.receiptNo}</span></>}</>}
        actions={<StatusPill status={sub.status} />}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          <fieldset disabled={!editable || busy} className="grid gap-4 sm:grid-cols-2">
            {t.fields.map((f) => (
              <div key={f.key} className={f.type === 'text' ? 'sm:col-span-2' : ''}>
                <Field label={`${f.label}${f.required ? ' *' : ''}`} htmlFor={f.key} error={errors[f.key]} hint={f.help}>
                  {f.type === 'select' ? (
                    <select id={f.key} className={inputCls} value={values[f.key] ?? ''} aria-invalid={!!errors[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                      <option value="">Choose…</option>
                      {f.options?.map((o) => <option key={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'text' ? (
                    <textarea id={f.key} rows={3} className={inputCls + ' h-auto py-2'} value={values[f.key] ?? ''} aria-invalid={!!errors[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                  ) : (
                    <input id={f.key} inputMode="numeric" className={inputCls + ' tnum'} value={values[f.key] ?? ''} aria-invalid={!!errors[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value.replace(/[^\d]/g, '') }))} />
                  )}
                </Field>
              </div>
            ))}
          </fieldset>
          {msg && <p className={'mt-4 text-sm ' + (msg.tone === 'warn' ? 'text-critical' : 'text-good-ink')} role="status">{msg.text}</p>}
          {editable && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button type="button" disabled={busy} onClick={() => void save()}>Save draft</Button>
              <Button variant="primary" type="submit" disabled={busy}>Submit to LGA</Button>
            </div>
          )}
        </form>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Supporting documents" subtitle="PDF, PNG or JPEG · max 10 MB · stored privately">
          {sub.attachments.length === 0 ? <p className="text-sm text-ink-2">No documents attached.</p> : (
            <ul className="space-y-1.5 text-sm">
              {sub.attachments.map((a, i) => (
                <li key={a.publicId} className="flex items-center justify-between gap-2">
                  <span className="truncate">{a.originalName}</span>
                  <button className="text-xs font-medium text-brand hover:underline" onClick={() => void openAttachment(i)}>Open</button>
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-brand">
              <input type="file" accept="application/pdf,image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
              + Attach document
            </label>
          )}
        </Card>
        <Card title="Activity history"><History items={sub.history} /></Card>
      </div>
      <Modal title="Submission receipt" open={!!receipt} onClose={() => setReceipt(null)}>
        {receipt && (
          <div className="space-y-3 text-sm">
            <p className="text-good-ink font-medium">✓ Report submitted to the LGA Collation Officer</p>
            <dl className="divide-y divide-line rounded-lg border border-line">
              {[
                ['Receipt number', <span className="font-mono">{receipt.receiptNo}</span>],
                ['Ward', receipt.ward],
                ['Exercise', receipt.exercise],
                ['Submitted by', receipt.submittedBy],
                ['Submitted at', fmtDate(receipt.submittedAt)],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3 px-3 py-2"><dt className="text-ink-2">{k}</dt><dd className="font-medium">{v}</dd></div>
              ))}
            </dl>
            <p className="text-xs text-muted">Keep this receipt number. Internal report — not an official result.</p>
            <Button onClick={() => window.print()}>Print receipt</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
