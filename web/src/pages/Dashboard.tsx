import { Link, useNavigate } from 'react-router';
import { download, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { compact, fmtDate, fmtInt, ago, pct } from '../lib/format';
import { Card, ErrorState, LoadingBlock, PageHeader, Severity, Skeleton, StatTile, StatusPill } from '../components/ui';
import { BarList, Columns, StackedBar } from '../components/charts';
import { AGE_BANDS } from '../../../shared/geo';

interface Metric { value: number | null; label: string; definition: string; source: string }
interface Overview {
  dataset: { mode: string; label: string; synthetic: boolean };
  scope: { level: string; roots: string[] };
  reportingPeriod: { registerPrintedYear: number; verifiedAt: string } | null;
  metrics: Record<string, Metric>;
  coverage: { lgas?: number; wards?: number; pus: number; pusComplete: number; pusCatalogued: number };
  reconciliation: { pusBalanced: number; pusUnbalanced: number; pusPartial: number } | null;
  gender: { male: number; female: number; unavailable: number };
  ageBands: Record<string, number>;
  issuesBySeverity: { _id: string; n: number; affected: number }[];
  imports: { latestJob: { _id: string; status: string; createdAt: string; finishedAt?: string; stopReason?: string; peakRssMb?: number }; lastSuccessfulAt: string | null; files: Record<string, number> } | null;
  pendingApprovals: number | null;
  recentExports: { _id: string; report: string; format: string; scope: string; at: string; userEmail: string; rows: number; status: string }[];
}
interface NodeResp { unit: { _id: string; name: string }; children: { _id: string; name: string; records: number; expected: number; level: string }[] }

export function Dashboard() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const ov = useApi<Overview>('/api/stats/overview');
  const root = ov.data?.scope.roots[0];
  const node = useApi<NodeResp>(root ? `/api/geo/node/${root}` : null, [root]);

  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const d = ov.data;
  const m = d?.metrics;
  const tile = (k: string, emphasis = false, note?: string) =>
    m?.[k] ? <StatTile key={k} label={m[k]!.label} value={fmtInt(m[k]!.value)} definition={m[k]!.definition} source={m[k]!.source} emphasis={emphasis} note={note} /> : null;
  const sev = ['critical', 'high', 'medium', 'low'];

  return (
    <div>
      <PageHeader
        title="Executive dashboard"
        subtitle={
          d ? (
            <>
              {d.dataset.label} · Scope: {me?.user.scopeLabel}
              {d.reportingPeriod && <> · Register printed {d.reportingPeriod.registerPrintedYear} · Verified {fmtDate(d.reportingPeriod.verifiedAt)}</>}
            </>
          ) : (
            'Loading…'
          )
        }
        actions={
          can('reports.export') && (
            <>
              <button onClick={() => void download(`/api/reports/executive-brief?format=pdf&scope=${d?.scope.roots[0] ?? '24'}`)} className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-ink hover:brightness-110">
                Executive brief (PDF)
              </button>
              <Link to="/reports" className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-surface-2">
                All reports
              </Link>
            </>
          )
        }
      />

      {!d ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tile('validatedUnique', true, d.metrics.expected?.value ? `${pct(d.metrics.validatedUnique!.value ?? 0, d.metrics.expected.value)} of register cover totals` : undefined)}
            {tile('expected')}
            {tile('rejectedRows')}
            {tile('duplicateVinRecords')}
          </div>
          {d.coverage && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {/* Technical counts are for data stewards/admins; executives see them on the Import and Audit pages. */}
              {can('imports.manage') && tile('rawRowsRead', false, 'Includes second copies; not a count of people')}
              {can('imports.manage') && tile('possibleDuplicateGroups')}
              {tile('genderUnknown')}
              {(() => {
                const b = d.ageBands;
                const known = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'].reduce((x, k) => x + (b[k] ?? 0), 0);
                const youth = (b['18-24'] ?? 0) + (b['25-34'] ?? 0);
                return <StatTile label="Youth share (18–34)" value={known ? pct(youth, known) : '—'} note={`${fmtInt(youth)} voters aged 18–34`} definition="Share of validated voters with a known birth year who are aged 18–34, relative to the register print year." source="Birth year in the register" />;
              })()}
              <StatTile label="Women (of known gender)" value={d.gender.female + d.gender.male ? pct(d.gender.female, d.gender.female + d.gender.male) : '—'} note={`${fmtInt(d.gender.female)} women · ${fmtInt(d.gender.male)} men`} definition="Female share among records whose gender is known. Records from alphabetical-only registers are excluded because their gender field is unreliable." />
              <StatTile
                label="Geographic coverage"
                value={`${fmtInt(d.coverage.pus)} PUs`}
                note={`${d.coverage.lgas !== undefined ? `${d.coverage.lgas} LGAs · ${d.coverage.wards} wards · ` : ''}${fmtInt(d.coverage.pusComplete)} of ${fmtInt(d.coverage.pusCatalogued)} catalogued PUs fully processed`}
                definition="Polling units with at least one validated record, out of the polling units found in the source catalogue."
                source="Source catalogue and aggregates"
              />
            </div>
          )}
        </>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={node.data ? `Validated records by ${node.data.children[0]?.level === 'lga' ? 'LGA' : node.data.children[0]?.level === 'ward' ? 'ward' : 'polling unit'}` : 'Validated records by area'}
          subtitle="Select an area to open it in the explorer"
        >
          {node.loading && !node.data ? (
            <LoadingBlock rows={8} />
          ) : node.error ? (
            <ErrorState error={node.error} onRetry={node.reload} />
          ) : (
            <BarList
              valueLabel="Validated records"
              items={[...(node.data?.children ?? [])].sort((a, b) => b.records - a.records).map((c) => ({ key: c._id, label: c.name, value: c.records, sub: c.expected ? `Register cover total ${fmtInt(c.expected)}` : undefined }))}
              onSelect={(code) => nav(`/explorer?code=${code}`)}
            />
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Reconciliation" subtitle="Register cover totals vs stored + rejected rows">
            {!d ? (
              <LoadingBlock rows={3} />
            ) : d.reconciliation ? (
              <dl className="space-y-2 text-sm">
                <Row label="Polling units balanced" value={fmtInt(d.reconciliation.pusBalanced)} />
                <Row label="Unbalanced (needs review)" value={fmtInt(d.reconciliation.pusUnbalanced)} warn={d.reconciliation.pusUnbalanced > 0} />
                <Row label="Not yet fully processed" value={fmtInt(d.reconciliation.pusPartial)} />
              </dl>
            ) : (
              <p className="text-sm text-ink-2">Available to state-wide users.</p>
            )}
          </Card>
          {can('quality.read') && (
            <Card title="Open data-quality issues" actions={<Link to="/quality" className="text-xs font-medium text-brand hover:underline">View all</Link>}>
              {!d ? (
                <LoadingBlock rows={3} />
              ) : (
                <ul className="space-y-2">
                  {sev.map((s) => {
                    const r = d.issuesBySeverity.find((x) => x._id === s);
                    return (
                      <li key={s} className="flex items-center justify-between text-sm">
                        <Severity level={s} />
                        <span className="tnum text-ink-2">
                          <span className="font-medium text-ink">{fmtInt(r?.n ?? 0)}</span> issues · {compact(r?.affected ?? 0)} affected
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Gender" subtitle="Validated records in scope">
          {!d ? (
            <Skeleton className="h-16" />
          ) : (
            <StackedBar
              label="Gender distribution"
              parts={[
                { key: 'f', label: 'Female', value: d.gender.female, color: 'var(--accent)' },
                { key: 'm', label: 'Male', value: d.gender.male, color: 'var(--accent-2)' },
                { key: 'u', label: 'Unavailable', value: d.gender.unavailable, color: 'var(--neutral-mark)' },
              ]}
            />
          )}

          {d && (d.gender.female + d.gender.male) > 0 && (
            <p className="mt-2 text-sm text-ink-2">
              Among records with known gender: <span className="font-medium text-ink">Female {((d.gender.female / (d.gender.female + d.gender.male)) * 100).toFixed(1)}%</span> · <span className="font-medium text-ink">Male {((d.gender.male / (d.gender.female + d.gender.male)) * 100).toFixed(1)}%</span>
            </p>
          )}
          <p className="mt-3 text-xs text-muted">“Unavailable” covers polling units supplied only as alphabetical copies, whose gender field is unreliable.</p>
        </Card>
        <Card title="Age bands" subtitle="From birth year, relative to the register print year">
          {!d ? <Skeleton className="h-40" /> : <Columns unit="records" items={AGE_BANDS.map((b) => ({ key: b, label: b === 'unknown' ? 'Unk.' : b, value: d.ageBands[b] ?? 0 }))} />}
        </Card>
        <div className="space-y-4">
          {d?.imports && (
            <Card title="Import pipeline" actions={<Link to="/imports" className="text-xs font-medium text-brand hover:underline">Details</Link>}>
              <dl className="space-y-2 text-sm">
                <Row label="Latest job" value={<StatusPill status={d.imports.latestJob.status} />} />
                <Row label="Last successful run" value={d.imports.lastSuccessfulAt ? ago(d.imports.lastSuccessfulAt) : '—'} />
                <Row label="Files processed" value={`${fmtInt(d.imports.files.done ?? 0)} / ${fmtInt(Object.values(d.imports.files).reduce((a, b) => a + b, 0))}`} />
                {(d.imports.files.failed ?? 0) > 0 && <Row label="Files failed" value={fmtInt(d.imports.files.failed)} warn />}
              </dl>
            </Card>
          )}
          {d && d.pendingApprovals !== null && (
            <Card title="Collation">
              <Row label="Ward reports awaiting review" value={fmtInt(d.pendingApprovals)} warn={d.pendingApprovals > 0} />
            </Card>
          )}
        </div>
      </div>

      {d && d.scope.level === 'state' && <DistrictStrip />}

      {d && d.recentExports.length > 0 && (
        <Card className="mt-4" title="Recent exports" pad={false}>
          <ul className="divide-y divide-line">
            {d.recentExports.map((e) => (
              <li key={e._id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span>
                  <span className="font-medium">{e.report}</span> <span className="uppercase text-muted">{e.format}</span> · {e.scope}
                </span>
                <span className="text-xs text-muted">
                  {e.userEmail} · {fmtDate(e.at)} {e.status === 'denied' && <StatusPill status="denied" />}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className={warn ? 'tnum font-semibold text-critical' : 'tnum font-medium text-ink'}>{value}</dd>
    </div>
  );
}

interface DistrictRow { code: string; name: string; color: string; records: number; pus: number; ageBands: Record<string, number>; lgas: { code: string }[] }

/** Senatorial districts at a glance (state-wide users). */
function DistrictStrip() {
  const nav = useNavigate();
  const d = useApi<{ items: DistrictRow[] }>('/api/geo/districts');
  if (!d.data) return null;
  const total = d.data.items.reduce((a, x) => a + x.records, 0);
  return (
    <Card className="mt-4" title="Senatorial districts" subtitle="Select a district to see it on the map" actions={<Link to="/explorer" className="text-xs font-medium text-brand hover:underline">Open explorer</Link>}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {d.data.items.map((x) => {
          const known = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'].reduce((a, k) => a + (x.ageBands[k] ?? 0), 0);
          const youth = (x.ageBands['18-24'] ?? 0) + (x.ageBands['25-34'] ?? 0);
          return (
            <button key={x.code} onClick={() => nav('/explorer?view=district')} className="rounded-xl border border-line p-4 text-left hover:border-line-strong">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <span className="h-3 w-3 rounded" style={{ background: x.color }} aria-hidden="true" />
                {x.name}
              </p>
              <p className="tnum mt-2 text-[26px] font-bold leading-8">{fmtInt(x.records)}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${(x.records / (total || 1)) * 100}%`, background: x.color }} />
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {pct(x.records, total)} of Lagos · {x.lgas.length} LGAs · {fmtInt(x.pus)} PUs · {pct(youth, known)} aged 18–34
              </p>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
