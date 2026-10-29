import { useState, type FormEvent } from 'react';
import { api, ApiError, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, inputCls, Notice, PageHeader, Tabs } from '../components/ui';

interface VinMatch { pu: string; ward: string; lga: string; birthYear: number | null; gender: string | null; source: { file: string | null; page: number; serial: number | null } }
interface NameMatch { pu: string; puName: string; ward: string; wardName: string; lga: string; lgaName: string; birthYear: number | null; gender: string | null }

const tc = (s: string) => s.toLowerCase().replace(/(^|[\s/-])\S/g, (c) => c.toUpperCase());

export function Lookup() {
  const { settings, can } = useAuth();
  const [tab, setTab] = useState<'name' | 'vin'>('name');
  // Online, only the name check is available (VIN fingerprints stay on the office machine).
  const online = !!settings?.deployment?.aggregateOnly;
  const vinAllowed = !online && can('records.lookup');
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Check registration"
        subtitle={online ? 'Confirm whether a specific person is on the register and where they vote. Search by the full name and birth year exactly as on the voter card.' : 'Confirm whether a specific person is on the register and where they vote. Search by the full name and birth year exactly as on the voter card, or by VIN.'}
        actions={!vinAllowed ? undefined : <Tabs value={tab} onChange={setTab} items={[{ value: 'name', label: 'By name' }, { value: 'vin', label: 'By VIN' }]} />}
      />
      <Notice tone="warn">Every check is recorded in the audit log with your reason. Use this only for a legitimate purpose, such as helping a person confirm their own registration.</Notice>
      {!vinAllowed || tab === 'name' ? <NameSearch /> : <VinSearch />}
    </div>
  );
}

function NameSearch() {
  const lgas = useApi<{ children: { _id: string; name: string }[] }>('/api/geo/node/24');
  const [name, setName] = useState('');
  const [year, setYear] = useState('');
  const [lga, setLga] = useState('');
  const [reason, setReason] = useState('');
  const [res, setRes] = useState<{ searched: { name: string; birthYear: number }; matches: NameMatch[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await api('/api/stats/records/name-lookup', { body: { name, birthYear: Number(year), lga, reason } }));
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Check failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Card className="mt-4">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Full name" htmlFor="nm" hint="All names on the voter card, in any order — e.g. surname, first name and middle name">
              <input id="nm" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" />
            </Field>
          </div>
          <Field label="Year of birth" htmlFor="by">
            <input id="by" inputMode="numeric" className={inputCls + ' tnum'} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="e.g. 1988" />
          </Field>
          <Field label="LGA (optional)" htmlFor="lg" hint="Narrows the check to one LGA">
            <select id="lg" className={inputCls} value={lga} onChange={(e) => setLga(e.target.value)}>
              <option value="">All of Lagos</option>
              {lgas.data?.children.map((l) => <option key={l._id} value={l._id}>{tc(l.name)}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason for the check" htmlFor="rs" hint="Recorded in the audit log">
              <input id="rs" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Supporter asked to confirm registration" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            {err && <p className="mb-2 text-sm text-critical" role="alert">{err}</p>}
            <Button variant="primary" type="submit" disabled={busy || name.trim().split(/\s+/).length < 2 || year.length !== 4 || reason.trim().length < 5}>
              {busy ? 'Checking…' : 'Check registration'}
            </Button>
          </div>
        </form>
      </Card>
      {res && (
        <Card className="mt-4">
          {res.matches.length === 0 ? (
            <div>
              <p className="text-lg font-semibold">No match for {tc(res.searched.name)}, born {res.searched.birthYear}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
                <li>Check the spelling and include every name on the voter card (middle names count).</li>
                <li>Check the year of birth.</li>
                <li>If you chose an LGA, try “All of Lagos” — the person may be registered elsewhere.</li>
                <li>Not finding a match does not prove the person is unregistered: 2 register files were unreadable, and names are matched exactly.</li>
              </ul>
            </div>
          ) : (
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-good-ink">
                <span aria-hidden="true">✓</span> {tc(res.searched.name)} is registered
              </p>
              <ul className="mt-3 space-y-3">
                {res.matches.map((m, i) => (
                  <li key={i} className="rounded-xl border border-line p-4">
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div><dt className="text-muted">Polling unit</dt><dd className="font-semibold">{tc(m.puName)} <span className="tnum font-normal text-muted">{m.pu}</span></dd></div>
                      <div><dt className="text-muted">Ward</dt><dd className="font-medium">{tc(m.wardName)}</dd></div>
                      <div><dt className="text-muted">LGA</dt><dd className="font-medium">{tc(m.lgaName)}</dd></div>
                      <div><dt className="text-muted">Year of birth · gender</dt><dd className="font-medium">{m.birthYear ?? '—'} · {m.gender === 'F' ? 'Female' : m.gender === 'M' ? 'Male' : 'Not recorded'}</dd></div>
                    </dl>
                  </li>
                ))}
              </ul>
              {res.matches.length > 1 && <p className="mt-3 text-sm text-ink-2">More than one person on the register shares this name and birth year. Confirm with the VIN on the voter card.</p>}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function VinSearch() {
  const [vin, setVin] = useState('');
  const [reason, setReason] = useState('');
  const [res, setRes] = useState<VinMatch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await api<{ matches: VinMatch[] }>('/api/stats/records/lookup', { body: { vin, reason } });
      setRes(r.matches);
      setVin('');
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Card className="mt-4">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="VIN" htmlFor="vin" hint="18–20 letters and digits">
            <input id="vin" className={inputCls + ' font-mono uppercase'} value={vin} onChange={(e) => setVin(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={20} autoComplete="off" />
          </Field>
          <Field label="Reason for the check" htmlFor="reason" hint="Recorded in the audit log">
            <input id="reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
          <div className="sm:col-span-2">
            {err && <p className="mb-2 text-sm text-critical" role="alert">{err}</p>}
            <Button variant="primary" type="submit" disabled={busy || vin.length < 18 || reason.trim().length < 5}>
              {busy ? 'Checking…' : 'Check VIN'}
            </Button>
          </div>
        </form>
      </Card>
      {res && (
        <Card className="mt-4" title={res.length ? `${res.length} match${res.length > 1 ? 'es' : ''}` : 'No match'}>
          {res.length === 0 ? (
            <p className="text-sm text-ink-2">This VIN is not in the processed register within your area.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {res.map((m, i) => (
                <li key={i} className="rounded-xl border border-line p-3">
                  <p className="tnum font-medium">Polling unit {m.pu}</p>
                  <p className="text-ink-2">Ward {m.ward} · LGA {m.lga} · Birth year {m.birthYear ?? '—'} · Gender {m.gender ?? 'not recorded'}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted">Source: {m.source.file} · page {m.source.page}{m.source.serial ? ` · serial ${m.source.serial}` : ''}</p>
                </li>
              ))}
              {res.length > 1 && <li><Notice tone="warn">This VIN appears in more than one polling unit. See “Duplicate VIN across PUs” in Data quality.</Notice></li>}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
