import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import type { Permission } from '../../../shared/roles';
import { cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  perm?: Permission;
  any?: Permission[];
  icon: ReactNode;
}

const I = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Overview',
    items: [
      { to: '/', label: 'Executive dashboard', perm: 'stats.read', icon: I('M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z') },
      { to: '/explorer', label: 'Geographic explorer', perm: 'stats.read', icon: I('M9 3 3 6v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15') },
      { to: '/situation', label: 'Situation room', perm: 'collation.read', icon: I('M3 5h18v11H3zM8 21h8M12 16v5') },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { to: '/audit-register', label: 'Register audit', perm: 'quality.read', icon: I('M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z') },
      { to: '/operations', label: 'Field operations', perm: 'stats.read', icon: I('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8') },
    ],
  },
  {
    group: 'Data',
    items: [
      { to: '/quality', label: 'Data quality', perm: 'quality.read', icon: I('M12 3 2 21h20zM12 10v5M12 18h.01') },
      { to: '/imports', label: 'Import pipeline', perm: 'imports.read', icon: I('M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3') },
      { to: '/lookup', label: 'Register lookup', perm: 'records.lookup', icon: I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3') },
    ],
  },
  {
    group: 'Collation',
    items: [
      { to: '/collation/ward', label: 'Ward workspace', perm: 'collation.submit', icon: I('M4 4h16v16H4zM8 9h8M8 13h8M8 17h5') },
      { to: '/collation/lga', label: 'LGA workspace', any: ['collation.review', 'collation.read'], icon: I('M3 7h18M3 12h18M3 17h18') },
    ],
  },
  {
    group: 'Governance',
    items: [
      { to: '/reports', label: 'Reports & exports', perm: 'reports.export', icon: I('M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6') },
      { to: '/audit', label: 'Audit log', perm: 'audit.read', icon: I('M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z') },
      { to: '/users', label: 'Users & access', perm: 'users.manage', icon: I('M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z') },
      { to: '/settings', label: 'Branding & media', perm: 'media.manage', icon: I('M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4') },
    ],
  },
];

function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('eip-theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('eip-theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function SyntheticBanner() {
  const { settings } = useAuth();
  if (settings?.dataset.mode === 'register')
    return (
      <div role="note" className="bg-[var(--brand)] px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-[var(--brand-ink)]">
        CONFIDENTIAL — figures derived from the INEC display register · aggregate view only · not official INEC statistics
      </div>
    );
  if (!settings?.dataset.synthetic) return null;
  return (
    <div role="note" className="bg-[var(--synthetic-bg)] px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-[var(--synthetic-ink)]">
      SYNTHETIC DEMONSTRATION DATA — figures are generated for demonstration and are not official Lagos voter statistics
    </div>
  );
}

export function Layout() {
  const { me, logout, can, settings } = useAuth();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!me) return null;
  const visible = NAV.map((g) => ({ ...g, items: g.items.filter((i) => (i.perm ? can(i.perm) : i.any ? i.any.some(can) : true)) })).filter((g) => g.items.length);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        {settings?.branding.logoUrl ? (
          <img src={settings.branding.logoUrl} alt="" className="h-8 w-8 rounded-md object-contain" />
        ) : (
          <span className="grid h-8 w-8 place-items-center rounded-md bg-brand text-sm font-bold text-brand-ink" aria-hidden="true">
            LE
          </span>
        )}
        <div className="leading-tight">
          <p className="text-sm font-semibold text-ink">Lagos Electoral</p>
          <p className="text-[11px] text-muted">Intelligence &amp; Operations</p>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {visible.map((g) => (
          <div key={g.group}>
            <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{g.group}</p>
            <ul className="space-y-0.5">
              {g.items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.to === '/'}
                    className={({ isActive }) =>
                      cx('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px]', isActive ? 'bg-brand-soft font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')
                    }
                  >
                    <span className="text-muted">{i.icon}</span>
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line p-3">
        <NavLink to="/account" className="block rounded-lg px-2 py-1.5 hover:bg-surface-2">
          <p className="truncate text-[13px] font-medium text-ink">{me.user.name}</p>
          <p className="truncate text-[11px] text-muted">
            {me.user.roleLabel} · {me.user.scopeLabel}
          </p>
        </NavLink>
        <div className="mt-2 flex items-center gap-1 px-1">
          <label className="sr-only" htmlFor="theme">
            Theme
          </label>
          <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)} className="h-8 flex-1 rounded-md border border-line bg-surface px-2 text-xs text-ink-2">
            <option value="system">System theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <button onClick={() => void logout()} className="h-8 rounded-md px-2.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen">
      <SyntheticBanner />
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-line bg-surface lg:block">{sidebar}</aside>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 max-w-[85%] bg-surface shadow-xl">{sidebar}</aside>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 lg:hidden">
            <button onClick={() => setOpen(true)} className="rounded-md p-1.5 hover:bg-surface-2" aria-label="Open navigation">
              {I('M4 6h16M4 12h16M4 18h16')}
            </button>
            <span className="text-sm font-semibold">Lagos Electoral Intelligence</span>
          </div>
          <main className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
