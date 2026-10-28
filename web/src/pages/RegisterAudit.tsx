import { useMemo, useState } from 'react';
import { ApiError, download, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInt } from '../lib/format';
import { Button, Card, ErrorState, LoadingBlock, Notice, PageHeader, StatTile } from '../components/ui';
import { DataTable } from '../components/DataTable';
import { BarList } from '../components/charts';
import { ScopePicker } from '../components/ScopePicker';

interface Row { code: string; name: string; records: number; dupVin: number; possibleDup: number; badBirthYear: number; rejected: number; countMismatch: number; total: number; per10k: number; [k: string]: unknown }
interface Totals { records: number; dupVin: number; possibleDup: number; badBirthYear: number; rejected: number; countMismatch: number; total: number }
interface Resp { scope: string; rows: Row[]; totals: Totals }

export function RegisterAudit() {
  const { can } = useAuth();
  const [scope, setScope] = useState('');
  const d = useApi<Resp>(scope ? `/api/insights/audit?scope=${scope}` : null, [scope]);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'total', dir: 'desc' });
  const [err, setErr] = useState<string | null>(null);
  const rows = useMemo(() => {
    const r = [...(d.data?.rows ?? [])];
    r.sort((a, b) => {
      const av = a[sort.key] as number | string;
      const bv = b[sort.key] as number | string;
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? c : -c;
    });
    return r;
  }, [d.data, sort]);
  const t = d.data?.totals;
  const exp = (f: string) => download(`/api/reports/register-audit?format=${f}&scope=${scope}`).catch((e) => setErr(e instanceof ApiError ? e.message : 'Export failed'));

  return (
    <div>
      <PageHeader
        title="Register audit"
        subtitle="Possible irregularities in the register, by area, prepared as evidence for INEC’s claims-and-objections process. Every finding is a candidate for review — check it against the source register before filing."
        actions={
          <>
            <ScopePicker value={scope} onChange={setScope} />
            {can('reports.export') && ['pdf', 'xlsx', 'csv'].map((f) => <Button key={f} className="uppercase" onClick={() => void exp(f)}>{f}</Button>)}
          </>
        }
      />
      {err && <p className="mb-3 text-sm text-critical" role="alert">{err}</p>}
      {d.error ? <ErrorState error={d.error} onRetry={d.reload} /> : !d.data || !t ? <LoadingBlock rows={6} /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile emphasis label="High-confidence findings" value={fmtInt(t.total)} note={t.records ? `${((t.total / t.records) * 10000).toFixed(1)} per 10,000 records` : undefined} definition="VINs appearing in another polling unit, implausible birth years, invalid rows and count gaps. Name matches are excluded because common names produce many false matches." />
            <StatTile label="VIN appears in another PU" value={fmtInt(t.dupVin)} definition="Records whose VIN also appears in a different polling unit (exact match). Strongest objection candidate." source="Rule D1" />
            <StatTile label="Name matches for manual review" value={fmtInt(t.possibleDup)} note="Low confidence — not counted as findings" definition="Records sharing a name and birth year with another record under a different VIN in the same ward. Common names cause false matches — manual review required." source="Rule D2" />
            <StatTile label="Implausible or invalid entries" value={fmtInt(t.badBirthYear + t.rejected + t.countMismatch)} note={`${fmtInt(t.badBirthYear)} birth year · ${fmtInt(t.rejected)} invalid · ${fmtInt(t.countMismatch)} count gaps`} definition="Entries implying age under 18 or over 120, rows missing a valid VIN or name, and differences between the printed register total and the entries found." />
          </div>
          <div className="mt-4">
            <Notice>
              <strong className="text-ink">How to use this:</strong> export the area’s report, have a data steward confirm each case against the printed register (source file and page are in the Data quality section), then file confirmed cases through the party’s official claims-and-objections channel within INEC’s window.
            </Notice>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
            <Card title="High-confidence findings per 10,000 records" subtitle="Highest rate first — where to focus review">
              <BarList valueLabel="per 10,000" items={[...d.data.rows].sort((a, b) => b.per10k - a.per10k).slice(0, 20).map((r) => ({ key: r.code, label: r.name, value: r.per10k, sub: `${fmtInt(r.total)} findings in ${fmtInt(r.records)} records` }))} />
            </Card>
            <Card title="Findings by area" pad={false}>
              <DataTable
                rows={rows}
                rowKey={(r) => r.code}
                sort={sort}
                onSort={(k) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' }))}
                onRowClick={(r) => r.code.split('-').length < 4 && setScope(r.code)}
                columns={[
                  { key: 'name', label: 'Area', sortable: true, render: (r) => <div><p className="font-medium">{r.name}</p><p className="tnum text-xs text-muted">{r.code}</p></div> },
                  { key: 'records', label: 'Records', numeric: true, sortable: true, render: (r) => fmtInt(r.records) },
                  { key: 'dupVin', label: 'VIN dup.', numeric: true, sortable: true, render: (r) => fmtInt(r.dupVin) },
                  { key: 'possibleDup', label: 'Name match*', numeric: true, sortable: true, render: (r) => fmtInt(r.possibleDup) },
                  { key: 'badBirthYear', label: 'Age', numeric: true, sortable: true, render: (r) => fmtInt(r.badBirthYear) },
                  { key: 'total', label: 'Total', numeric: true, sortable: true, render: (r) => <span className="font-semibold">{fmtInt(r.total)}</span> },
                  { key: 'per10k', label: 'Per 10k', numeric: true, sortable: true, render: (r) => r.per10k.toFixed(1) },
                ]}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
