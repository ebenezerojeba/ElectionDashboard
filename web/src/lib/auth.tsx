import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { GeoScope, Permission, Role } from '../../../shared/roles';

export interface Me {
  user: { id: string; email: string; name: string; role: Role; roleLabel: string; scope: GeoScope; scopeLabel: string; mfaEnabled: boolean; mfaRequired: boolean; mustChangePassword: boolean };
  permissions: Permission[];
  mfa: 'ok' | 'verify' | 'enroll' | 'none';
}

export interface PublicSettings {
  dataset: { mode: string; label: string; synthetic: boolean };
  branding: { logoUrl?: string | null };
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  settings: PublicSettings | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    api<PublicSettings>('/api/public/settings').then(setSettings).catch(() => {});
    const onUnauth = () => setMe(null);
    window.addEventListener('eip:unauthenticated', onUnauth);
    return () => window.removeEventListener('eip:unauthenticated', onUnauth);
  }, [refresh]);
  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
  }, []);
  const can = useCallback((p: Permission) => !!me?.permissions.includes(p), [me]);
  return <Ctx.Provider value={{ me, loading, settings, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
