import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtInt, titleCase } from '../lib/format';
import { Button, Card, ErrorState, Field, inputCls, smallSelect, fieldCls, LoadingBlock, Modal, PageHeader, Severity, StatusPill } from '../components/ui';
import { DataTable, Pager } from '../components/DataTable';

interface Issue {
  _id: string;
  category: string;
  severity: string;
  title: string;
  lga: string | null;
  ward: string | null;
  pu: string | null;
  affected: number;
  status: string;
  lastDetectedAt: string;
  firstDetectedAt: string;
  history: { at: string; by: string; action: string; note?: string; from?: string; to?: string }[];
  files?: { _id: string; relPath: string; status: string; error?: string }[];
  [k: string]: unknown;
}

const CATEGORY_HELP: Record<string, string> = {
  FILE_UNREADABLE: 'A source file could not be read even with the fallback extractor.',
  FILE_CHANGED_AFTER_IMPORT: 'The source file’s size or date changed after import; re-processing is required.',
  COVER_CODE_MISMATCH: 'The polling-unit code printed in the register differs from its folder location.',
  ROWS_REJECTED: 'Rows with a missing/malformed VIN or missing name. Kept for review, never silently dropped.',
  BIRTH_YEAR_IMPLAUSIBLE: 'Birth year missing or implying an age under 18 or over 120. The record is kept.',
  COUNT_MISMATCH: 'Stored + rejected rows do not equal the register’s printed total (may indicate a VIN repeated within the register).',
  VARIANT_DISAGREEMENT: 'The alphabetical and default copies of a register contain different entries.',
  GENDER_UNAVAILABLE: 'Only the alphabetical copy exists; its gender field marks everyone “M”, so gender is not reported.',
  DUPLICATE_VIN_ACROSS_PUS: 'The same VIN appears in more than one polling unit (rule D1).',
  POSSIBLE_DUPLICATE_REGISTRATION: 'Same normalised name and birth year with different VINs in one ward (rule D2). Candidates only.',
  SERIAL_GAP: 'Missing serial numbers in a register sequence.',
  UNRECOGNISED_PAGES: 'Pages that could not be read or matched to the register layout.',
  GEO_UNMATCHED_BOUNDARY: 'No verified boundary shape matched this area name.',
};

const CATEGORY_LABEL: Record<string, string> = {
  FILE_UNREADABLE: 'File unreadable',
  FILE_CHANGED_AFTER_IMPORT: 'File changed after import',
  COVER_CODE_MISMATCH: 'Cover code mismatch',
  ROWS_REJECTED: 'Rows rejected',
  BIRTH_YEAR_IMPLAUSIBLE: 'Birth year implausible',
  COUNT_MISMATCH: 'Count mismatch',
  VARIANT_DISAGREEMENT: 'Copies disagree',
  GENDER_UNAVAILABLE: 'Gender unavailable',
  DUPLICATE_VIN_ACROSS_PUS: 'Duplicate VIN across PUs',
  POSSIBLE_DUPLICATE_REGISTRATION: 'Possible duplicate registration',
  SERIAL_GAP: 'Serial gap',
  UNRECOGNISED_PAGES: 'Unrecognised pages',
  GEO_UNMATCHED_BOUNDARY: 'No matching boundary',
};
const catLabel = (c: string) => CATEGORY_LABEL[c] ?? titleCase(c);

export function Quality() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState({ category: '', severity: '', status: 'open', pu: params.get('pu') ?? '' });
  const [page, setPage] = useState(1);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: '25' });
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }, [filters, page]);
  const summary = useApi<{ rows: { _id: { category: string; status: string; severity: string }; issues: number; affected: number }[] }>('/api/stats/quality/summary');
  const list = useApi<{ items: Issue[]; total: number; page: number; limit: number }>(`/api/stats/quality/issues?${qs}`, [qs]);
  const [open, setOpen] = useState<string | null>(null);

  const byCat = useMemo(() => {
    const m = new Map<string, { category: string; severity: string; open: number; resolved: number; affected: number }>();
    for (const r of summary.data?.rows ?? []) {
      const e = m.get(r._id.category) ?? { category: r._id.category, severity: r._id.severity, open: 0, resolved: 0, affected: 0 };
      if (['open', 'in_review'].includes(r._id.status)) {
        e.open += r.issues;
        e.affected += r.affected;
      } else e.resolved += r.issues;
      m.set(r._id.category, e);
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    return [...m.values()].sort((a, b) => order[a.severity]! - order[b.severity]! || b.open - a.open);
  }, [summary.data]);

  const set = (k: keyof typeof filters, v: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  };

  return (
    <div>
      <PageHeader title="Data quality" subtitle="Issues are detected automatically during import verification. Source data is never changed; every decision is recorded with its history." />

      <Card title="Issue categories" subtitle="Open = open or in review. Select a category to filter the list." pad={false}>
        {summary.error ? (
          <div className="p-5"><ErrorState error={summary.error} onRetry={summary.reload} /></div>
        ) : !summary.data ? (
          <div className="p-5"><LoadingBlock /></div>
        ) : (
          <DataTable
            rows={byCat as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.category)}
            onRowClick={(r) => set('category', filters.category === r.category ? '' : String(r.category))}
            columns={[
              { key: 'severity', label: 'Severity', render: (r) => <Severity level={String(r.severity)} /> },
              {
                key: 'category',
                label: 'Category',
                render: (r) => (
                  <div>
                    <p className={filters.category === r.category ? 'font-semibold text-ink' : 'font-medium'}>{catLabel(String(r.category))}</p>
                    <p className="text-xs text-muted">{CATEGORY_HELP[String(r.category)] ?? ''}</p>
                  </div>
                ),
              },
              { key: 'open', label: 'Open issues', numeric: true, render: (r) => fmtInt(r.open as number) },
              { key: 'affected', label: 'Affected count', numeric: true, render: (r) => fmtInt(r.affected as number) },
              { key: 'resolved', label: 'Resolved / accepted', numeric: true, render: (r) => fmtInt(r.resolved as number) },
            ]}
            empty="No data-quality issues detected."
          />
        )}
      </Card>

      <Card
        className="mt-4"
        title="Issues"
        pad={false}
        actions={
          <div className="flex flex-wrap gap-2">
            <select aria-label="Severity" className={smallSelect} value={filters.severity} onChange={(e) => set('severity', e.target.value)}>
              <option value="">All severities</option>
              {['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
            <select aria-label="Status" className={smallSelect} value={filters.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">All statuses</option>
              {['open', 'in_review', 'resolved', 'accepted_risk'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
            {(filters.category || filters.pu) && (
              <Button className="h-8 text-xs" onClick={() => setFilters((f) => ({ ...f, category: '', pu: '' }))}>
                Clear {filters.category ? catLabel(filters.category) : filters.pu} ✕
              </Button>
            )}
          </div>
        }
      >
        {list.error ? (
          <div className="p-5"><ErrorState error={list.error} onRetry={list.reload} /></div>
        ) : !list.data ? (
          <div className="p-5"><LoadingBlock rows={8} /></div>
        ) : (
          <>
            <DataTable
              rows={list.data.items}
              rowKey={(r) => r._id}
              onRowClick={(r) => setOpen(r._id)}
              columns={[
                { key: 'severity', label: 'Severity', render: (r) => <Severity level={r.severity} /> },
                { key: 'title', label: 'Issue', render: (r) => <div><p className="font-medium">{r.title}</p><p className="text-xs text-muted">{catLabel(r.category)}</p></div> },
                { key: 'scope', label: 'Area', render: (r) => <span className="tnum text-xs text-ink-2">{r.pu ?? r.ward ?? r.lga ?? 'State'}</span> },
                { key: 'affected', label: 'Affected', numeric: true, render: (r) => fmtInt(r.affected) },
                { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
                { key: 'lastDetectedAt', label: 'Last detected', render: (r) => <span className="text-xs text-ink-2">{fmtDate(r.lastDetectedAt)}</span> },
              ]}
              empty="No issues match these filters."
            />
            <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal title="Issue detail" open={!!open} onClose={() => setOpen(null)} wide>
        {open && <IssueDetail id={open} canManage={can('quality.manage')} onChanged={() => { list.reload(); summary.reload(); }} />}
      </Modal>
    </div>
  );
}

function IssueDetail({ id, canManage, onChanged }: { id: string; canManage: boolean; onChanged: () => void }) {
  const d = useApi<Issue>(`/api/stats/quality/issues/${encodeURIComponent(id)}`, [id]);
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (d.error) return <ErrorState error={d.error} />;
  if (!d.data) return <LoadingBlock />;
  const i = d.data;
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/stats/quality/issues/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, note } });
      setNote('');
      setStatus('');
      d.reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5 text-sm">
      <div>
        <div className="flex flex-wrap items-center gap-3"><Severity level={i.severity} /><StatusPill status={i.status} /><span className="text-xs text-muted">{catLabel(i.category)}</span></div>
        <p className="mt-2 text-base font-medium">{i.title}</p>
        <p className="mt-1 text-ink-2">{CATEGORY_HELP[i.category]}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div><dt className="text-muted">Area</dt><dd className="tnum">{i.pu ?? i.ward ?? i.lga ?? 'State'}</dd></div>
          <div><dt className="text-muted">Affected</dt><dd className="tnum">{fmtInt(i.affected)}</dd></div>
          <div><dt className="text-muted">First detected</dt><dd>{fmtDate(i.firstDetectedAt)}</dd></div>
          <div><dt className="text-muted">Last detected</dt><dd>{fmtDate(i.lastDetectedAt)}</dd></div>
        </dl>
      </div>
      {i.files && i.files.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Source files (data stewards only)</p>
          <ul className="space-y-1">
            {i.files.map((f) => (
              <li key={f._id} className="rounded bg-surface-2 px-2 py-1 font-mono text-xs break-all">
                {f.relPath} <StatusPill status={f.status} /> {f.error && <span className="text-critical">{f.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-medium text-muted">History</p>
        <ol className="space-y-2 border-l border-line pl-4">
          {i.history.map((h, n) => (
            <li key={n}>
              <p className="text-xs text-muted">{fmtDate(h.at)} · {h.by}</p>
              <p>
                {titleCase(h.action)}
                {h.from && h.to && <> — {titleCase(h.from)} → {titleCase(h.to)}</>}
              </p>
              {h.note && <p className="text-ink-2">“{h.note}”</p>}
            </li>
          ))}
        </ol>
      </div>
      {canManage && (
        <div className="space-y-3 border-t border-line pt-4">
          <p className="font-medium">Record a decision</p>
          <Field label="New status" htmlFor="st">
            <select id="st" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Choose…</option>
              {['open', 'in_review', 'resolved', 'accepted_risk'].filter((s) => s !== i.status).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
          </Field>
          <Field label="Note (required)" htmlFor="note" hint="Explain the finding or correction. Source files are never modified.">
            <textarea id="note" rows={3} className={inputCls + ' h-auto py-2'} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {err && <p className="text-sm text-critical" role="alert">{err}</p>}
          <Button variant="primary" disabled={busy || !status || note.trim().length < 3} onClick={() => void save()}>Save decision</Button>
        </div>
      )}
    </div>
  );
}
