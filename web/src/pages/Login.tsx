import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field, inputCls } from '../components/ui';
import { SyntheticBanner } from '../components/Layout';

type Step = 'credentials' | 'verify' | 'enroll';

export function Login() {
  const { refresh, me } = useAuth();
  const [step, setStep] = useState<Step>(me?.mfa === 'verify' ? 'verify' : me?.mfa === 'enroll' ? 'enroll' : 'credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mfa: 'none' | 'verify' | 'enroll' }>('/api/auth/login', { body: { email, password } });
      if (r.mfa === 'none') return void (await refresh());
      setStep(r.mfa);
      if (r.mfa === 'enroll') setEnroll(await api('/api/auth/mfa/setup', { method: 'POST' }));
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function startEnroll() {
    setEnroll(await api('/api/auth/mfa/setup', { method: 'POST' }));
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(step === 'enroll' ? '/api/auth/mfa/confirm' : '/api/auth/mfa/verify', { body: { code } });
      await refresh();
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : 'Verification failed');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SyntheticBanner />
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px]">
          <div className="mb-6 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand text-base font-bold text-brand-ink" aria-hidden="true">
              LE
            </span>
            <div>
              <h1 className="text-lg font-semibold">Lagos Electoral Intelligence</h1>
              <p className="text-xs text-muted">Restricted system · authorised users only</p>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface p-6">
            {step === 'credentials' ? (
              <form onSubmit={submitCredentials} className="space-y-4" noValidate>
                <Field label="Email" htmlFor="email">
                  <input id="email" type="email" autoComplete="username" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password" htmlFor="password">
                  <input id="password" type="password" autoComplete="current-password" required className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
                {error && (
                  <p role="alert" className="text-sm text-critical">
                    {error}
                  </p>
                )}
                <Button variant="primary" type="submit" className="w-full" disabled={busy || !email || !password}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            ) : (
              <form onSubmit={submitCode} className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold">{step === 'enroll' ? 'Set up two-step verification' : 'Two-step verification'}</h2>
                  <p className="mt-1 text-sm text-ink-2">
                    {step === 'enroll'
                      ? 'Your role requires an authenticator app. Add this key to Google Authenticator, Microsoft Authenticator or similar, then enter the 6-digit code.'
                      : 'Enter the 6-digit code from your authenticator app.'}
                  </p>
                </div>
                {step === 'enroll' &&
                  (enroll ? (
                    <div className="rounded-lg bg-surface-2 p-3">
                      <p className="text-xs text-muted">Setup key (time-based)</p>
                      <p className="mt-1 break-all font-mono text-sm tracking-wider text-ink select-all">{enroll.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
                    </div>
                  ) : (
                    <Button type="button" onClick={() => void startEnroll()}>
                      Show setup key
                    </Button>
                  ))}
                <Field label="Verification code" htmlFor="code">
                  <input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    className={inputCls + ' tnum text-center text-lg tracking-[0.4em]'}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                  />
                </Field>
                {error && (
                  <p role="alert" className="text-sm text-critical">
                    {error}
                  </p>
                )}
                <Button variant="primary" type="submit" className="w-full" disabled={busy || code.length !== 6}>
                  {busy ? 'Verifying…' : 'Verify'}
                </Button>
              </form>
            )}
          </div>
          <p className="mt-4 text-center text-[11px] leading-relaxed text-muted">All activity is logged. Access is limited to your assigned role and area.</p>
        </div>
      </div>
    </div>
  );
}
