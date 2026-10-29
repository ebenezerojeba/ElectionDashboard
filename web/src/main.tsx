import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Skeleton } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Explorer } from './pages/Explorer';
import { Quality } from './pages/Quality';
import { Imports } from './pages/Imports';
import { Lookup } from './pages/Lookup';
import { WardWorkspace } from './pages/collation/WardWorkspace';
import { LgaWorkspace } from './pages/collation/LgaWorkspace';
import { Reports } from './pages/Reports';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';
import { Account, ForcePasswordChange, Settings } from './pages/Settings';
import { RegisterAudit } from './pages/RegisterAudit';
import { OpsPlanner } from './pages/OpsPlanner';
import { Situation } from './pages/Situation';
import type { Permission } from '../../shared/roles';

function Guard({ perm, children }: { perm?: Permission | Permission[]; children: ReactNode }) {
  const { can } = useAuth();
  const ok = !perm || (Array.isArray(perm) ? perm.some(can) : can(perm));
  return ok ? <>{children}</> : <p className="text-sm text-ink-2">You do not have access to this page.</p>;
}

function Home() {
  const { me, can } = useAuth();
  if (me?.user.role === 'ward_officer') return <Navigate to="/collation/ward" replace />;
  if (me?.user.role === 'lga_officer') return <Navigate to="/collation/lga" replace />;
  if (me?.user.role === 'auditor' && !can('stats.read')) return <Navigate to="/audit" replace />;
  return <Dashboard />;
}

function App() {
  const { me, loading } = useAuth();
  if (loading)
    return (
      <div className="mx-auto max-w-md space-y-3 p-10" role="status" aria-label="Loading">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-24" />
      </div>
    );
  if (!me || me.mfa !== 'ok') return <Login />;
  if (me.user.mustChangePassword) return <ForcePasswordChange />;
  return (
    <Routes>
      <Route path="situation" element={<Guard perm="collation.read"><Situation /></Guard>} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="explorer" element={<Guard perm="stats.read"><Explorer /></Guard>} />
        <Route path="audit-register" element={<Guard perm="quality.read"><RegisterAudit /></Guard>} />
        <Route path="operations" element={<Guard perm="stats.read"><OpsPlanner /></Guard>} />
        <Route path="quality" element={<Guard perm="quality.read"><Quality /></Guard>} />
        <Route path="imports" element={<Guard perm="imports.read"><Imports /></Guard>} />
        <Route path="lookup" element={<Guard perm="records.check"><Lookup /></Guard>} />
        <Route path="collation/ward" element={<Guard perm="collation.submit"><WardWorkspace /></Guard>} />
        <Route path="collation/lga" element={<Guard perm={['collation.review', 'collation.read']}><LgaWorkspace /></Guard>} />
        <Route path="reports" element={<Guard perm="reports.export"><Reports /></Guard>} />
        <Route path="users" element={<Guard perm="users.manage"><Users /></Guard>} />
        <Route path="audit" element={<Guard perm="audit.read"><Audit /></Guard>} />
        <Route path="settings" element={<Guard perm="media.manage"><Settings /></Guard>} />
        <Route path="account" element={<Account />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
