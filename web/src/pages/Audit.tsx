import { useState } from 'react';
import { useApi } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Card, ErrorState, inputCls, smallSelect, fieldCls, LoadingBlock, PageHeader, StatusPill } from '../components/ui';
import { DataTable, Pager } from '../components/DataTable';

interface Ev { _id: string; at: string; actorEmail?: string; actorRole?: string; action: string; outcome: string; target?: string; ip?: string; detail?: Record<string, unknown>; [k: string]: unknown }

export function Audit() {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), limit: '50', ...(action && { action }), ...(outcome && { outcome }), ...(actor && { actor }) }).toString();
  const list = useApi<{ items: Ev[]; total: number; page: number; limit: number }>(`/api/stats/audit?${qs}`, [qs]);
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Append-only record of sign-ins, access denials, data changes, lookups and exports. Personal values (such as VINs) are never written here." />
      <Card
        pad={false}
        title="Events"
        actions={
          <div className="flex flex-wrap gap-2">
            <select aria-label="Action" className={smallSelect} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
              <option value="">All actions</option>
              {['auth.', 'access.', 'user.', 'collation.', 'report.', 'records.', 'quality.', 'import.', 'media.', 'config.'].map((a) => <option key={a} value={a}>{a.replace('.', '')}</option>)}
            </select>
            <select aria-label="Outcome" className={smallSelect} value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}>
              <option value="">All outcomes</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </select>
            <input aria-label="Actor email" placeholder="Actor email" className={fieldCls('w-48').replace('h-9','h-8') + ' text-xs'} value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }} />
          </div>
        }
      >
        {list.error ? <div className="p-5"><ErrorState error={list.error} /></div> : !list.data ? <div className="p-5"><LoadingBlock rows={10} /></div> : (
          <>
            <DataTable
              rows={list.data.items}
              rowKey={(r) => r._id}
              columns={[
                { key: 'at', label: 'Time', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDate(r.at)}</span> },
                { key: 'actorEmail', label: 'Actor', render: (r) => <div className="text-xs"><p>{r.actorEmail ?? 'system'}</p><p className="text-muted">{r.actorRole ?? ''}</p></div> },
                { key: 'action', label: 'Action', render: (r) => <span className="font-mono text-xs">{r.action}</span> },
                { key: 'outcome', label: 'Outcome', render: (r) => <StatusPill status={r.outcome} /> },
                { key: 'target', label: 'Target', render: (r) => <span className="text-xs break-all">{r.target ?? ''}</span> },
                { key: 'detail', label: 'Detail', render: (r) => <span className="font-mono text-[11px] text-ink-2 break-all">{r.detail ? JSON.stringify(r.detail).slice(0, 160) : ''}</span> },
                { key: 'ip', label: 'IP', render: (r) => <span className="text-xs text-muted">{r.ip ?? ''}</span> },
              ]}
            />
            <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
