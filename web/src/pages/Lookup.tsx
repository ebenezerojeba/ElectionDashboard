import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Button, Card, Field, inputCls, Notice, PageHeader } from '../components/ui';

interface Match { pu: string; ward: string; lga: string; birthYear: number | null; gender: string | null; source: { file: string | null; page: number; serial: number | null } }

export function Lookup() {
  const [vin, setVin] = useState('');
  const [reason, setReason] = useState('');
  const [res, setRes] = useState<Match[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await api<{ matches: Match[] }>('/api/stats/records/lookup', { body: { vin, reason } });
      setRes(r.matches);
      setVin('');
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-3xl">
      <PageHeader title="Register lookup" subtitle="Restricted to data stewards. Confirms whether a VIN is in the processed register and where. Names are not stored by the platform and are never returned." />
      <Notice tone="warn">Every lookup is recorded in the audit log with your stated reason. The VIN itself is not logged.</Notice>
      <Card className="mt-4">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="VIN" htmlFor="vin" hint="18–20 letters and digits">
            <input id="vin" className={inputCls + ' font-mono uppercase'} value={vin} onChange={(e) => setVin(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={20} autoComplete="off" />
          </Field>
          <Field label="Reason for lookup" htmlFor="reason" hint="e.g. data-quality issue reference">
            <input id="reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
          <div className="sm:col-span-2">
            {err && <p className="mb-2 text-sm text-critical" role="alert">{err}</p>}
            <Button variant="primary" type="submit" disabled={busy || vin.length < 18 || reason.trim().length < 5}>
              {busy ? 'Checking…' : 'Look up'}
            </Button>
          </div>
        </form>
      </Card>
      {res && (
        <Card className="mt-4" title={res.length ? `${res.length} match${res.length > 1 ? 'es' : ''}` : 'No match'}>
          {res.length === 0 ? (
            <p className="text-sm text-ink-2">This VIN is not in the processed register within your scope.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {res.map((m, i) => (
                <li key={i} className="rounded-lg border border-line p-3">
                  <p className="font-medium tnum">Polling unit {m.pu}</p>
                  <p className="text-ink-2">Ward {m.ward} · LGA {m.lga} · Birth year {m.birthYear ?? '—'} · Gender {m.gender ?? 'unavailable'}</p>
                  <p className="mt-1 font-mono text-xs text-muted break-all">Source: {m.source.file} · page {m.source.page}{m.source.serial ? ` · serial ${m.source.serial}` : ''}</p>
                </li>
              ))}
              {res.length > 1 && <li><Notice tone="warn">This VIN appears in more than one polling unit. See the “Duplicate VIN across PUs” data-quality issues.</Notice></li>}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
