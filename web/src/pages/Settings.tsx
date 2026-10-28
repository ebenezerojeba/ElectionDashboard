import { useState } from 'react';
import { api, ApiError, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Button, Card, ErrorState, Field, inputCls, LoadingBlock, Notice, PageHeader } from '../components/ui';

interface Media { _id: string; publicId: string; format: string; bytes: number; at: string; url?: string }

export function Settings() {
  const { refresh } = useAuth();
  const status = useApi<{ cloudinaryConfigured: boolean; folder: string }>('/api/media/status');
  const list = useApi<{ items: Media[] }>('/api/media');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/media/branding', { form });
      setMsg('Uploaded.');
      list.reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-4xl">
      <PageHeader title="Branding & media" subtitle="Approved logos and banners are stored in Cloudinary through the server. Voter data and register files are never uploaded." />
      {status.data && !status.data.cloudinaryConfigured && (
        <Notice tone="warn">Cloudinary is not configured on this server. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the server environment (never to the web app).</Notice>
      )}
      <Card className="mt-4" title="Upload branding image" subtitle="PNG, JPEG, WebP or SVG (no scripts) · max 5 MB · public delivery">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-brand">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" disabled={busy || !status.data?.cloudinaryConfigured} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          {busy ? 'Uploading…' : '+ Choose image'}
        </label>
        {msg && <p className="mt-2 text-sm text-ink-2">{msg}</p>}
      </Card>
      <Card className="mt-4" title="Branding assets">
        {list.error ? <ErrorState error={list.error} /> : !list.data ? <LoadingBlock /> : list.data.items.length === 0 ? <p className="text-sm text-ink-2">No branding assets uploaded.</p> : (
          <ul className="grid gap-3 sm:grid-cols-3">
            {list.data.items.map((m) => (
              <li key={m._id} className="rounded-lg border border-line p-3">
                {m.url && <img src={m.url} alt="" className="h-24 w-full rounded object-contain bg-surface-2" />}
                <p className="mt-2 truncate text-xs text-ink-2">{m.publicId}</p>
                <p className="text-xs text-muted">{(m.bytes / 1024).toFixed(0)} KB · {fmtDate(m.at, false)}</p>
                <div className="mt-2 flex gap-2">
                  <Button className="h-8 text-xs" onClick={() => api('/api/media/branding/logo', { body: { mediaId: m._id } }).then(refresh).then(() => window.location.reload())}>Use as logo</Button>
                  <Button className="h-8 text-xs" variant="ghost" onClick={() => api(`/api/media/${m._id}`, { method: 'DELETE' }).then(list.reload)}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function Account() {
  const { me } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function change() {
    setMsg(null);
    try {
      await api('/api/auth/password', { body: { current: cur, next } });
      setMsg('Password changed. Other sessions have been signed out.');
      setCur('');
      setNext('');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not change password');
    }
  }
  return (
    <div className="max-w-xl">
      <PageHeader title="My account" />
      <Card title="Profile">
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-ink-2">Name</dt><dd>{me?.user.name}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Email</dt><dd>{me?.user.email}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Role</dt><dd>{me?.user.roleLabel}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Scope</dt><dd>{me?.user.scopeLabel}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Two-step verification</dt><dd>{me?.user.mfaEnabled ? 'Enabled' : 'Not enabled'}</dd></div>
        </dl>
      </Card>
      <Card className="mt-4" title="Change password">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void change(); }}>
          <Field label="Current password" htmlFor="cur"><input id="cur" type="password" autoComplete="current-password" className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="New password" htmlFor="nw" hint="At least 12 characters with letters and digits"><input id="nw" type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          {msg && <p className="text-sm text-ink-2" role="status">{msg}</p>}
          <Button variant="primary" type="submit" disabled={!cur || next.length < 12}>Change password</Button>
        </form>
      </Card>
    </div>
  );
}

/** Shown instead of the app until a user with a temporary password chooses their own. */
export function ForcePasswordChange() {
  const { me, refresh, logout } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (next !== confirm) return setErr('The new passwords do not match');
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/password', { body: { current: cur, next } });
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px] rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold">Choose your own password</h1>
        <p className="mt-1 text-sm text-ink-2">
          {me?.user.name}, your account was issued a temporary password. Set a private one before continuing.
        </p>
        <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Temporary password" htmlFor="fc"><input id="fc" type="password" autoComplete="current-password" className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="New password" htmlFor="fn" hint="At least 12 characters with letters and digits"><input id="fn" type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label="Confirm new password" htmlFor="fx"><input id="fx" type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          {err && <p className="text-sm text-critical" role="alert">{err}</p>}
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={busy || !cur || next.length < 12 || !confirm}>Save and continue</Button>
            <Button type="button" variant="ghost" onClick={() => void logout()}>Sign out</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
