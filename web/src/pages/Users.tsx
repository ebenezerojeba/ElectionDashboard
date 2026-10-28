import { useState } from 'react';
import { api, ApiError, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Button, Card, ErrorState, Field, inputCls, smallSelect, fieldCls, LoadingBlock, Modal, PageHeader, StatusPill } from '../components/ui';
import { DataTable, Pager } from '../components/DataTable';
import { ROLE_LABELS, ROLES, type Role } from '../../../shared/roles';

interface U { id: string; email: string; name: string; role: Role; roleLabel: string; scopeLabel: string; mfaEnabled: boolean; mfaRequired: boolean; status: string; lastLoginAt: string | null; [k: string]: unknown }

export function Users() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ items: U[]; total: number; page: number; limit: number }>(`/api/users?page=${page}&limit=25${q ? `&q=${encodeURIComponent(q)}` : ''}${role ? `&role=${role}` : ''}`, [q, role, page]);
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<U | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(u: U, path: string, body?: unknown, method = 'POST') {
    setMsg(null);
    try {
      await api(`/api/users/${u.id}${path}`, { method, body: body ?? {} });
      setMsg('Saved.');
      list.reload();
      setSel(null);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Action failed');
    }
  }

  return (
    <div>
      <PageHeader title="Users & access" subtitle="Assign roles and geographic scope. Revoking access ends the user’s sessions immediately." actions={<Button variant="primary" onClick={() => setCreating(true)}>Add user</Button>} />
      {msg && <p className="mb-3 text-sm text-ink-2" role="status">{msg}</p>}
      <Card
        pad={false}
        title="Accounts"
        actions={
          <div className="flex gap-2">
            <input aria-label="Search users" placeholder="Search name or email" className={fieldCls('w-56').replace('h-9','h-8') + ' text-xs'} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <select aria-label="Role" className={smallSelect} value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
              <option value="">All roles</option>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        }
      >
        {list.error ? <div className="p-5"><ErrorState error={list.error} /></div> : !list.data ? <div className="p-5"><LoadingBlock rows={6} /></div> : (
          <>
            <DataTable
              rows={list.data.items}
              rowKey={(r) => r.id}
              onRowClick={setSel}
              columns={[
                { key: 'name', label: 'Name', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.email}</p></div> },
                { key: 'roleLabel', label: 'Role' },
                { key: 'scopeLabel', label: 'Scope', render: (r) => <span className="text-xs">{r.scopeLabel}</span> },
                { key: 'mfa', label: 'MFA', render: (r) => (r.mfaEnabled ? <span className="text-xs text-good-ink">✓ Enabled</span> : r.mfaRequired ? <span className="text-xs text-critical">Required — not set up</span> : <span className="text-xs text-muted">Optional</span>) },
                { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status === 'revoked' ? 'denied' : 'success'} /> },
                { key: 'lastLoginAt', label: 'Last sign-in', render: (r) => <span className="text-xs">{fmtDate(r.lastLoginAt)}</span> },
              ]}
            />
            <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal title="Add user" open={creating} onClose={() => setCreating(false)}>
        <UserForm onDone={() => { setCreating(false); list.reload(); }} />
      </Modal>
      <Modal title={sel?.name ?? 'User'} open={!!sel} onClose={() => setSel(null)}>
        {sel && (
          <div className="space-y-4 text-sm">
            <p className="text-ink-2">{sel.email} · {sel.roleLabel} · {sel.scopeLabel}</p>
            <div className="flex flex-wrap gap-2">
              {sel.id !== me?.user.id && (sel.status === 'active' ? (
                <Button variant="danger" onClick={() => void act(sel, '', { status: 'revoked' }, 'PATCH')}>Revoke access</Button>
              ) : (
                <Button onClick={() => void act(sel, '', { status: 'active' }, 'PATCH')}>Reactivate</Button>
              ))}
              <Button onClick={() => void act(sel, '/reset-mfa')}>Reset MFA</Button>
              <Button onClick={() => void act(sel, '/unlock')}>Unlock</Button>
            </div>
            <ResetPassword onSubmit={(p) => act(sel, '/reset-password', { password: p })} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function ResetPassword({ onSubmit }: { onSubmit: (p: string) => Promise<void> }) {
  const [p, setP] = useState('');
  return (
    <div className="flex items-end gap-2 border-t border-line pt-4">
      <div className="flex-1">
        <Field label="Set a temporary password" htmlFor="rp" hint="At least 12 characters with letters and digits. Ends the user’s sessions.">
          <input id="rp" type="password" autoComplete="new-password" className={inputCls} value={p} onChange={(e) => setP(e.target.value)} />
        </Field>
      </div>
      <Button disabled={p.length < 12} onClick={() => void onSubmit(p).then(() => setP(''))}>Set</Button>
    </div>
  );
}

function UserForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'executive_viewer' as Role, level: 'state', codes: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forcedLevel = f.role === 'ward_officer' ? 'ward' : f.role === 'lga_officer' ? 'lga' : null;
  const level = forcedLevel ?? f.level;
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const codes = f.codes.split(/[\s,]+/).filter(Boolean);
      await api('/api/users', { body: { name: f.name, email: f.email, role: f.role, password: f.password, scope: level === 'state' ? { level } : { level, codes } } });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not create user');
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Full name" htmlFor="n"><input id="n" className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="Email" htmlFor="e"><input id="e" type="email" className={inputCls} value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
      <Field label="Role" htmlFor="r" hint={['system_admin', 'data_steward', 'auditor', 'report_reviewer'].includes(f.role) ? 'This role must set up an authenticator app at first sign-in.' : undefined}>
        <select id="r" className={inputCls} value={f.role} onChange={(e) => set('role', e.target.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
      </Field>
      <Field label="Geographic scope" htmlFor="l">
        <select id="l" className={inputCls} value={level} disabled={!!forcedLevel} onChange={(e) => set('level', e.target.value)}>
          <option value="state">Lagos State</option>
          <option value="lga">Specific LGAs</option>
          <option value="ward">Specific wards</option>
        </select>
      </Field>
      {level !== 'state' && (
        <Field label={level === 'lga' ? 'LGA codes' : 'Ward codes'} htmlFor="c" hint={level === 'lga' ? 'e.g. 24-11 (comma-separated)' : 'e.g. 24-11-03 (comma-separated)'}>
          <input id="c" className={inputCls + ' font-mono'} value={f.codes} onChange={(e) => set('codes', e.target.value)} />
        </Field>
      )}
      <Field label="Temporary password" htmlFor="p" hint="At least 12 characters with letters and digits. Share it securely.">
        <input id="p" type="password" autoComplete="new-password" className={inputCls} value={f.password} onChange={(e) => set('password', e.target.value)} />
      </Field>
      {err && <p className="text-sm text-critical" role="alert">{err}</p>}
      <Button variant="primary" type="submit" disabled={busy}>Create user</Button>
    </form>
  );
}
