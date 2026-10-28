import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, download, useApi, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInt, pct } from '../lib/format';
import { Button, Card, ErrorState, LoadingBlock, Notice, PageHeader, StatTile, Tabs, inputCls, smallSelect, fieldCls } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { StackedBar } from '../components/charts';
import { ChoroplethMap, type MapFeatureCollection } from '../components/ChoroplethMap';
import { METRICS } from '../../../shared/metrics';

interface Agg {
  _id: string;
  level: 'state' | 'lga' | 'ward' | 'pu';
  name: string;
  records: number;
  expected: number | null;
  rejected: number;
  male: number;
  female: number;
  genderUnknown: number;
  dupVinRecords: number;
  pus: number;
  pusComplete: number;
  [k: string]: unknown;
}
interface NodeResp {
  unit: Agg;
  geo: { verified: boolean; source: string } | null;
  breadcrumbs: { code: string; name: string; accessible: boolean }[];
  children: Agg[];
}

const LEVEL_NAME = { state: 'State', lga: 'LGA', ward: 'Ward (registration area)', pu: 'Polling unit' } as const;
const CHILD_NAME = { state: 'LGAs', lga: 'Wards', ward: 'Polling units', pu: '' } as const;
type MetricKey = 'records' | 'rejected' | 'dupVinRecords';
const METRIC_LABEL: Record<MetricKey, string> = { records: 'Validated records', rejected: 'Rejected rows', dupVinRecords: 'Duplicate VIN candidates' };

export function Explorer() {
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const roots = me?.user.scope.level === 'state' ? ['24'] : (me?.user.scope as { codes: string[] }).codes;
  const code = params.get('code') ?? roots[0]!;
  const node = useApi<NodeResp>(`/api/geo/node/${code}`, [code]);
  const [view, setView] = useState<'map' | 'table'>('map');
  const [metric, setMetric] = useState<MetricKey>('records');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: '_id', dir: 'asc' });
  const [boundaries, setBoundaries] = useState<MapFeatureCollection | null>(null);

  useEffect(() => {
    api<MapFeatureCollection>('/api/geo/boundaries?level=lga').then(setBoundaries).catch(() => setBoundaries(null));
  }, []);

  const go = (c: string) => setParams({ code: c });
  const unit = node.data?.unit;
  const children = node.data?.children ?? [];
  const rows = useMemo(() => {
    const r = [...children];
    const k = sort.key;
    r.sort((a, b) => {
      const av = a[k] as number | string;
      const bv = b[k] as number | string;
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? c : -c;
    });
    return r;
  }, [children, sort]);

  const mapAvailable = unit?.level === 'state' && !!boundaries?.features.length;
  const showMap = mapAvailable && view === 'map';

  const cols: Column<Agg>[] = [
    { key: '_id', label: 'Code', sortable: true, className: 'tnum text-ink-2 whitespace-nowrap' },
    { key: 'name', label: 'Name', sortable: true, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'records', label: 'Validated', numeric: true, sortable: true, render: (r) => fmtInt(r.records) },
    { key: 'expected', label: 'Cover total', numeric: true, sortable: true, render: (r) => (r.pusComplete ? fmtInt(r.expected) : '—') },
    { key: 'rejected', label: 'Rejected', numeric: true, sortable: true, render: (r) => fmtInt(r.rejected) },
    { key: 'female', label: 'Female', numeric: true, sortable: true, render: (r) => fmtInt(r.female) },
    { key: 'male', label: 'Male', numeric: true, sortable: true, render: (r) => fmtInt(r.male) },
    { key: 'genderUnknown', label: 'Gender n/a', numeric: true, sortable: true, render: (r) => fmtInt(r.genderUnknown) },
    { key: 'dupVinRecords', label: 'Dup. VIN', numeric: true, sortable: true, render: (r) => fmtInt(r.dupVinRecords) },
    {
      key: 'status',
      label: 'Reconciled',
      render: (r) =>
        r.pusComplete < r.pus ? (
          <span className="text-xs text-muted">{r.pusComplete}/{r.pus} PUs</span>
        ) : (r.expected ?? 0) === r.records + r.rejected ? (
          <span className="text-xs font-medium text-good-ink">✓ Balanced</span>
        ) : (
          <span className="text-xs font-semibold text-critical">▲ Unbalanced</span>
        ),
    },
  ];

  const [exportErr, setExportErr] = useState<string | null>(null);
  async function exp(format: string) {
    setExportErr(null);
    try {
      await download(`/api/reports/geo-aggregate?format=${format}&scope=${code}`);
    } catch (e) {
      setExportErr(e instanceof ApiError ? e.message : 'Export failed');
    }
  }

  return (
    <div>
      <PageHeader
        title="Geographic explorer"
        subtitle="Aggregate figures only — individual voter details are never shown. Drill down from state to LGA, ward and polling unit."
        actions={<AreaSearch onPick={go} />}
      />

      {node.data && (
        <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
          {node.data.breadcrumbs.map((b) => (
            <span key={b.code} className="flex items-center gap-1">
              {b.accessible ? (
                <button className="text-ink-2 hover:text-ink hover:underline" onClick={() => go(b.code)}>
                  {b.name}
                </button>
              ) : (
                <span className="text-muted">{b.name}</span>
              )}
              <span className="text-muted" aria-hidden="true">
                /
              </span>
            </span>
          ))}
          <span className="font-medium text-ink" aria-current="page">
            {unit?.name}
          </span>
        </nav>
      )}

      {node.error ? (
        <ErrorState error={node.error} onRetry={node.reload} />
      ) : !unit ? (
        <LoadingBlock rows={6} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted">
                {LEVEL_NAME[unit.level]} · <span className="tnum">{unit._id}</span>
                {node.data?.geo && !node.data.geo.verified && <span className="ml-2 text-critical">name from folder only — not verified</span>}
              </p>
              <h2 className="text-xl font-semibold">{unit.name}</h2>
            </div>
            {can('reports.export') && (
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-xs text-muted">Export this scope</span>
                {['pdf', 'xlsx', 'csv'].map((f) => (
                  <Button key={f} onClick={() => void exp(f)} className="h-8 px-2.5 uppercase">
                    {f}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {exportErr && <p className="mb-3 text-sm text-critical" role="alert">{exportErr}</p>}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label={METRICS.records.label} value={fmtInt(unit.records)} definition={METRICS.records.definition} source={METRICS.records.source} emphasis />
            <StatTile label={METRICS.expected.label} value={unit.pusComplete ? fmtInt(unit.expected) : '—'} note={`${fmtInt(unit.pusComplete)} of ${fmtInt(unit.pus)} PUs fully processed`} definition={METRICS.expected.definition} source={METRICS.expected.source} />
            <StatTile label={METRICS.rejectedRows.label} value={fmtInt(unit.rejected)} definition={METRICS.rejectedRows.definition} source={METRICS.rejectedRows.source} />
            <StatTile label={METRICS.duplicateVinRecords.label} value={fmtInt(unit.dupVinRecords)} note={unit.records ? `${pct(unit.dupVinRecords, unit.records)} of records` : undefined} definition={METRICS.duplicateVinRecords.definition} source={METRICS.duplicateVinRecords.source} />
          </div>

          <Card className="mt-4" title="Gender">
            <StackedBar
              label={`Gender in ${unit.name}`}
              parts={[
                { key: 'f', label: 'Female', value: unit.female, color: 'var(--accent)' },
                { key: 'm', label: 'Male', value: unit.male, color: 'var(--accent-2)' },
                { key: 'u', label: 'Unavailable', value: unit.genderUnknown, color: 'var(--neutral-mark)' },
              ]}
            />
            {(unit.female + unit.male) > 0 && (
              <p className="mt-2 text-sm text-ink-2">
                Among records with known gender: <span className="font-medium text-ink">Female {((unit.female / (unit.female + unit.male)) * 100).toFixed(1)}%</span> · <span className="font-medium text-ink">Male {((unit.male / (unit.female + unit.male)) * 100).toFixed(1)}%</span>
              </p>
            )}
          </Card>

          {unit.level !== 'pu' && (
            <Card
              className="mt-4"
              title={`${CHILD_NAME[unit.level]} in ${unit.name}`}
              subtitle={`${children.length} areas · select a row${showMap ? ' or a shape' : ''} to drill down`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {showMap && (
                    <select aria-label="Map metric" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} className={smallSelect}>
                      {Object.entries(METRIC_LABEL).map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                  {mapAvailable && <Tabs value={view} onChange={setView} items={[{ value: 'map', label: 'Map + table' }, { value: 'table', label: 'Table only' }]} />}
                </div>
              }
            >
              {!mapAvailable && unit.level !== 'state' && (
                <div className="mb-4">
                  <Notice>
                    Verified {unit.level === 'lga' ? 'ward' : 'polling-unit'} boundaries are not available, so this level is shown as a table. INEC registration areas do not match administrative ward
                    boundaries; shapes will be added only from an authorised source.
                  </Notice>
                </div>
              )}
              <div className={showMap ? 'grid gap-4 xl:grid-cols-[1.1fr_1fr]' : ''}>
                {showMap && boundaries && (
                  <ChoroplethMap
                    boundaries={boundaries}
                    values={Object.fromEntries(children.map((c) => [c._id, c[metric] as number]))}
                    names={Object.fromEntries(children.map((c) => [c._id, c.name]))}
                    metricLabel={METRIC_LABEL[metric]}
                    onSelect={go}
                  />
                )}
                <div className={showMap ? 'max-h-[400px] overflow-y-auto' : ''}>
                  <DataTable
                    caption={`${CHILD_NAME[unit.level]} in ${unit.name}`}
                    columns={showMap ? cols.filter((c) => ['_id', 'name', 'records', 'rejected', 'dupVinRecords', 'status'].includes(c.key)) : cols}
                    rows={rows}
                    rowKey={(r) => r._id}
                    sort={sort}
                    onSort={(k) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : k === '_id' || k === 'name' ? 'asc' : 'desc' }))}
                    onRowClick={(r) => go(r._id)}
                  />
                </div>
              </div>
            </Card>
          )}
          {unit.level === 'pu' && (
            <div className="mt-4 flex gap-2">
              {can('quality.read') && <Button onClick={() => nav(`/quality?pu=${unit._id}`)}>Data-quality issues for this polling unit</Button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AreaSearch({ onPick }: { onPick: (code: string) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<{ _id: string; name: string; level: string }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setItems([]);
    const t = setTimeout(() => {
      api<{ items: typeof items }>(`/api/geo/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setItems(r.items))
        .catch(() => setItems([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative w-72 max-w-full">
      <label htmlFor="area-search" className="sr-only">
        Search areas
      </label>
      <input id="area-search" className={inputCls} placeholder="Search LGA, ward, polling unit or code…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {items.length > 0 && (
        <ul className="absolute right-0 z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg" role="listbox">
          {items.map((i) => (
            <li key={i._id}>
              <button
                role="option"
                aria-selected="false"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => {
                  onPick(i._id);
                  setQ('');
                  setItems([]);
                }}
              >
                <span className="truncate">{i.name}</span>
                <span className="shrink-0 text-[11px] uppercase text-muted">
                  {i.level} · {i._id}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
