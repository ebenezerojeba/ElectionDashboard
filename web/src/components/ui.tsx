import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ApiError } from '../lib/api';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, pad = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

/** Stat tile: label · value · definition (always available via the info disclosure). */
export function StatTile({ label, value, note, definition, source, emphasis }: { label: string; value: ReactNode; note?: ReactNode; definition?: string; source?: string; emphasis?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={cx('relative rounded-xl border border-line bg-surface p-4', emphasis && 'ring-1 ring-brand/30')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] text-ink-2">{label}</p>
        {definition && (
          <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="-m-1 rounded p-1 text-muted hover:text-ink" title="Definition and source">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7v4M8 4.5v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <span className="sr-only">Show definition for {label}</span>
          </button>
        )}
      </div>
      <p className={cx('mt-1 font-semibold tracking-tight text-ink', emphasis ? 'text-[34px] leading-10' : 'text-[26px] leading-8')}>{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      {open && definition && (
        <div id={id} className="mt-3 border-t border-line pt-2 text-xs leading-relaxed text-ink-2">
          {definition}
          {source && <p className="mt-1 text-muted">Source: {source}</p>}
        </div>
      )}
    </div>
  );
}

const SEV: Record<string, { color: string; label: string; icon: ReactNode }> = {
  critical: { color: 'var(--critical)', label: 'Critical', icon: <path d="M8 1.5 15 14H1z" /> },
  high: { color: 'var(--serious)', label: 'High', icon: <path d="M8 1.5 15 14H1z" /> },
  medium: { color: 'var(--warning)', label: 'Medium', icon: <circle cx="8" cy="8" r="6" /> },
  low: { color: 'var(--neutral-mark)', label: 'Low', icon: <circle cx="8" cy="8" r="5" /> },
};

/** Severity: icon + label, never colour alone. */
export function Severity({ level }: { level: string }) {
  const s = SEV[level] ?? SEV.low!;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill={s.color}>
        {s.icon}
      </svg>
      {s.label}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  approved: 'bg-[color-mix(in_oklab,var(--good)_14%,transparent)] text-good-ink',
  done: 'bg-[color-mix(in_oklab,var(--good)_14%,transparent)] text-good-ink',
  completed: 'bg-[color-mix(in_oklab,var(--good)_14%,transparent)] text-good-ink',
  resolved: 'bg-[color-mix(in_oklab,var(--good)_14%,transparent)] text-good-ink',
  success: 'bg-[color-mix(in_oklab,var(--good)_14%,transparent)] text-good-ink',
  submitted: 'bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink',
  running: 'bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink',
  processing: 'bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink',
  in_review: 'bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink',
  returned: 'bg-[color-mix(in_oklab,var(--serious)_18%,transparent)] text-ink',
  failed: 'bg-[color-mix(in_oklab,var(--critical)_16%,transparent)] text-ink',
  denied: 'bg-[color-mix(in_oklab,var(--critical)_16%,transparent)] text-ink',
  failure: 'bg-[color-mix(in_oklab,var(--critical)_16%,transparent)] text-ink',
  missing: 'bg-[color-mix(in_oklab,var(--critical)_16%,transparent)] text-ink',
  changed: 'bg-[color-mix(in_oklab,var(--serious)_18%,transparent)] text-ink',
  stopped: 'bg-[color-mix(in_oklab,var(--warning)_22%,transparent)] text-ink',
  open: 'bg-[color-mix(in_oklab,var(--warning)_22%,transparent)] text-ink',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize', STATUS_STYLE[status] ?? 'bg-surface-2 text-ink-2')}>{status.replace(/_/g, ' ')}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const status = (error as ApiError).status;
  const msg = status === 403 ? 'You do not have access to this information.' : error.message;
  return (
    <div role="alert" className="rounded-lg border border-[color-mix(in_oklab,var(--critical)_40%,transparent)] bg-[color-mix(in_oklab,var(--critical)_7%,transparent)] p-4 text-sm text-ink">
      <p className="font-medium">Could not load this section</p>
      <p className="mt-1 text-ink-2">{msg}</p>
      {onRetry && status !== 403 && (
        <button className="mt-3 text-sm font-medium text-brand underline underline-offset-2" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong p-6 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function Button({ variant = 'secondary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-brand-ink hover:brightness-110',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'bg-critical text-white hover:brightness-110',
        className,
      )}
    />
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs font-medium text-critical" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const fieldBase =
  'rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-2 disabled:text-ink-2';
export const inputCls = 'h-9 w-full ' + fieldBase;
/** Compact control for toolbars (no full width). */
export const smallSelect = 'h-8 w-auto text-xs ' + fieldBase;
export const fieldCls = (w: string) => 'h-9 ' + w + ' ' + fieldBase;

export function Modal({ title, open, onClose, children, wide }: { title: string; open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className={cx('m-auto w-[calc(100%-32px)] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/40', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="text-base font-semibold">{title}</h2>
        <button onClick={onClose} className="rounded p-1 text-muted hover:text-ink" aria-label="Close">
          ✕
        </button>
      </header>
      <div className="max-h-[75vh] overflow-y-auto p-5">{open && children}</div>
    </dialog>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={cx('h-8 rounded-md px-3 text-sm', value === i.value ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div className={cx('rounded-lg border px-4 py-3 text-sm', tone === 'warn' ? 'border-[color-mix(in_oklab,var(--warning)_50%,transparent)] bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] text-ink' : 'border-line bg-surface-2 text-ink-2')}>
      {children}
    </div>
  );
}
