import { useState } from 'react';
import { api, ApiError, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtInt } from '../lib/format';
import { Button, Card, ErrorState, LoadingBlock, Notice, PageHeader, StatTile, StatusPill, inputCls, smallSelect, fieldCls } from '../components/ui';
import { DataTable, Pager } from '../components/DataTable';
import { METRICS } from '../../../shared/metrics';

interface Summary {
  byStatus: { _id: string; files: number; bytes: number; rows: number }[];
  catalog: { scanned: number; totalBytes: number; unrecognised: string[]; missing: number; at: string } | null;
  verification: { at: string; rawRowsRead: number; preferredRows: number; validatedUnique: number; rejectedRows: number; reconciliation: { pusBalanced: number; pusUnbalanced: number; pusPartial: number } } | null;
  authorization: { by: string; reference: string; at: string } | null;
}
interface Job { _id: string; status: string; options: { pathPrefix?: string; limitFiles?: number; memoryLimitMb: number }; createdAt: string; startedAt?: string; finishedAt?: string; heartbeatAt?: string; peakRssMb?: number; stopReason?: string; filesProcessedThisRun?: number; createdBy?: string }
interface FileRow { _id: string; relPath: string; status: string; variant: string; size: number; attempts: number; extractor?: string; counts?: { parsed: number; rejected: number; inserted: number; matched: number; pages: number }; cover?: { records?: number }; error?: string; durationMs?: number; [k: string]: unknown }

export function Imports() {
  const { can } = useAuth();
  const s = useApi<Summary>('/api/stats/imports/summary');
  const jobs = useApi<{ items: Job[] }>('/api/stats/imports/jobs?limit=10');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const files = useApi<{ items: FileRow[]; total: number; page: number; limit: number }>(`/api/stats/imports/files?limit=25&page=${page}${status ? `&status=${status}` : ''}`, [status, page]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const total = s.data?.byStatus.reduce((a, b) => a + b.files, 0) ?? 0;
  const st = (k: string) => s.data?.byStatus.find((b) => b._id === k)?.files ?? 0;
  const running = jobs.data?.items.find((j) => j.status === 'running');

  async function verify() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/stats/imports/verify', { method: 'POST' });
      setMsg('Verification complete. Aggregates and data-quality issues were refreshed.');
      s.reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Import pipeline"
        subtitle="Register files are processed by a separate worker (npm run ingest), one file at a time, with resumable progress. This page shows its state."
        actions={can('imports.manage') && <Button onClick={() => void verify()} disabled={busy || !!running}>{busy ? 'Verifying…' : 'Re-run verification'}</Button>}
      />
      {msg && <div className="mb-4"><Notice>{msg}</Notice></div>}
      {s.error ? (
        <ErrorState error={s.error} onRetry={s.reload} />
      ) : !s.data ? (
        <LoadingBlock rows={4} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Files processed" value={`${fmtInt(st('done'))} / ${fmtInt(total)}`} note={`${fmtInt(st('pending'))} pending · ${fmtInt(st('failed'))} failed · ${fmtInt(st('changed'))} changed`} emphasis />
            <StatTile label={METRICS.rawRowsRead.label} value={fmtInt(s.data.verification?.rawRowsRead)} definition={METRICS.rawRowsRead.definition} source={METRICS.rawRowsRead.source} />
            <StatTile label={METRICS.validatedUnique.label} value={fmtInt(s.data.verification?.validatedUnique)} definition={METRICS.validatedUnique.definition} source={METRICS.validatedUnique.source} />
            <StatTile label={METRICS.rejectedRows.label} value={fmtInt(s.data.verification?.rejectedRows)} definition={METRICS.rejectedRows.definition} source={METRICS.rejectedRows.source} />
          </div>
          {total > 0 && (
            <div className="mt-4" aria-label="Import progress">
              <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2">
                <div className="bg-[var(--good)]" style={{ width: `${(st('done') / total) * 100}%` }} />
                <div className="bg-[var(--critical)]" style={{ width: `${(st('failed') / total) * 100}%` }} />
                <div className="bg-[var(--accent)]" style={{ width: `${(st('processing') / total) * 100}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-ink-2">
                <span className="mr-3">■ <span className="text-good-ink">Done</span> {((st('done') / total) * 100).toFixed(1)}%</span>
                <span className="mr-3">■ <span className="text-critical">Failed</span> {fmtInt(st('failed'))}</span>
                <span>□ Pending {fmtInt(st('pending'))}</span>
              </p>
            </div>
          )}
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card title="Source catalogue">
              {s.data.catalog ? (
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-2">Files catalogued</dt><dd className="tnum">{fmtInt(s.data.catalog.scanned)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">Size</dt><dd className="tnum">{(s.data.catalog.totalBytes / 1024 ** 3).toFixed(2)} GB</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">Unrecognised paths</dt><dd className="tnum">{fmtInt(s.data.catalog.unrecognised.length)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">Missing since last scan</dt><dd className="tnum">{fmtInt(s.data.catalog.missing)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">Scanned</dt><dd>{fmtDate(s.data.catalog.at)}</dd></div>
                </dl>
              ) : <p className="text-sm text-ink-2">Not yet scanned.</p>}
            </Card>
            <Card title="Reconciliation">
              {s.data.verification ? (
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-2">PUs balanced</dt><dd className="tnum">{fmtInt(s.data.verification.reconciliation.pusBalanced)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">PUs unbalanced</dt><dd className={s.data.verification.reconciliation.pusUnbalanced ? 'tnum font-semibold text-critical' : 'tnum'}>{fmtInt(s.data.verification.reconciliation.pusUnbalanced)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">PUs not fully processed</dt><dd className="tnum">{fmtInt(s.data.verification.reconciliation.pusPartial)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-2">Verified</dt><dd>{fmtDate(s.data.verification.at)}</dd></div>
                </dl>
              ) : <p className="text-sm text-ink-2">No verification yet.</p>}
            </Card>
            <Card title="Authorisation for full import">
              {s.data.authorization ? (
                <div className="text-sm">
                  <p className="font-medium text-good-ink">✓ Attestation recorded</p>
                  <p className="mt-1 text-ink-2">By {s.data.authorization.by} · ref. {s.data.authorization.reference}</p>
                  <p className="text-xs text-muted">{fmtDate(s.data.authorization.at)}</p>
                </div>
              ) : (
                <p className="text-sm text-ink-2">
                  <span className="font-medium text-critical">Not recorded.</span> The worker refuses a full import until an authorised person records an attestation, a pilot balances, and disk checks pass.
                </p>
              )}
            </Card>
          </div>
        </>
      )}

      <Card className="mt-4" title="Recent jobs" pad={false}>
        {jobs.error ? <div className="p-5"><ErrorState error={jobs.error} /></div> : !jobs.data ? <div className="p-5"><LoadingBlock /></div> : (
          <DataTable
            rows={jobs.data.items as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r._id)}
            columns={[
              { key: 'status', label: 'Status', render: (r) => <StatusPill status={String(r.status)} /> },
              { key: 'scope', label: 'Scope', render: (r) => <span className="font-mono text-xs">{(r as unknown as Job).options.pathPrefix ?? 'All files'}{(r as unknown as Job).options.limitFiles ? ` (max ${(r as unknown as Job).options.limitFiles})` : ''}</span> },
              { key: 'createdAt', label: 'Started', render: (r) => fmtDate(String(r.createdAt)) },
              { key: 'finishedAt', label: 'Finished', render: (r) => (r.finishedAt ? fmtDate(String(r.finishedAt)) : '—') },
              { key: 'filesProcessedThisRun', label: 'Files (last run)', numeric: true, render: (r) => fmtInt(r.filesProcessedThisRun as number) },
              { key: 'peakRssMb', label: 'Peak memory', numeric: true, render: (r) => (r.peakRssMb ? `${r.peakRssMb} MB` : '—') },
              { key: 'stopReason', label: 'Stop reason', render: (r) => <span className="text-xs text-ink-2">{String(r.stopReason ?? '')}</span> },
            ]}
            empty="No import jobs yet."
          />
        )}
      </Card>

      <Card
        className="mt-4"
        title="Source files"
        subtitle="Per-file results. Paths contain polling-unit locations only — no personal data."
        pad={false}
        actions={
          <select aria-label="File status" className={smallSelect} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {['pending', 'processing', 'done', 'failed', 'changed'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        }
      >
        {files.error ? <div className="p-5"><ErrorState error={files.error} /></div> : !files.data ? <div className="p-5"><LoadingBlock rows={8} /></div> : (
          <>
            <DataTable
              rows={files.data.items}
              rowKey={(r) => r._id}
              columns={[
                { key: 'relPath', label: 'File', render: (r) => <span className="font-mono text-[11px] break-all">{r.relPath}</span> },
                { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
                { key: 'variant', label: 'Copy', render: (r) => <span className="text-xs">{r.variant === 'alpha' ? 'A–Z' : 'Default'}</span> },
                { key: 'cover', label: 'Cover total', numeric: true, render: (r) => fmtInt(r.cover?.records) },
                { key: 'parsed', label: 'Accepted', numeric: true, render: (r) => fmtInt(r.counts?.parsed) },
                { key: 'rejected', label: 'Rejected', numeric: true, render: (r) => fmtInt(r.counts?.rejected) },
                { key: 'inserted', label: 'New / matched', numeric: true, render: (r) => (r.counts ? `${fmtInt(r.counts.inserted)} / ${fmtInt(r.counts.matched)}` : '—') },
                { key: 'extractor', label: 'Reader', render: (r) => <span className="text-xs text-ink-2">{r.extractor ?? '—'}{r.error && <span className="block text-critical">{r.error}</span>}</span> },
              ]}
            />
            <Pager page={files.data.page} limit={files.data.limit} total={files.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
