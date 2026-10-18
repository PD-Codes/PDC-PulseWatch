import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { get } from './lib/api';
import { useAuth } from './lib/auth';
import { StreamProvider } from './lib/stream';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import Setup from './pages/Setup';

const page = (loader: () => Promise<{ default: React.ComponentType<any> }>) => lazy(loader);
const Dashboard = page(() => import('./pages/Dashboard'));
const MonitorDetail = page(() => import('./pages/MonitorDetail'));
const MonitorForm = page(() => import('./pages/MonitorForm'));
const Kiosk = page(() => import('./pages/Kiosk'));
const Insights = page(() => import('./pages/Insights'));
const Incidents = page(() => import('./pages/Incidents'));
const IncidentDetail = page(() => import('./pages/IncidentDetail'));
const Maintenance = page(() => import('./pages/Maintenance'));
const Notifications = page(() => import('./pages/Notifications'));
const Probes = page(() => import('./pages/Probes'));
const Groups = page(() => import('./pages/Groups'));
const StatusPagesAdmin = page(() => import('./pages/StatusPagesAdmin'));
const PublicStatus = page(() => import('./pages/PublicStatus'));
const Users = page(() => import('./pages/Users'));
const Audit = page(() => import('./pages/Audit'));
const Settings = page(() => import('./pages/Settings'));
const Reports = page(() => import('./pages/Reports'));
const Profile = page(() => import('./pages/Profile'));

/** Signed-in area: redirects to setup or login, and keeps the live event stream open. */
function Protected({ role, children }: { role?: 'editor' | 'admin'; children?: React.ReactNode }) {
  const { user, loading, can } = useAuth();
  const loc = useLocation();
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => get<{ needsSetup: boolean }>('/api/setup/status'), enabled: !loading && !user, staleTime: 60_000 });
  if (loading || (!user && setup.isLoading)) return <Loading />;
  if (!user) return <Navigate to={setup.data?.needsSetup ? '/setup' : '/login'} replace state={{ from: loc.pathname + loc.search }} />;
  if (role && !can(role)) return <NotFound />;
  return <StreamProvider>{children ?? <Layout />}</StreamProvider>;
}

const guard = (el: React.ReactElement, role?: 'editor' | 'admin') => (role ? <Protected role={role}>{el}</Protected> : el);

export default function App() {
  // a status page served on its own domain replaces the whole app
  const host = useQuery({ queryKey: ['host-page'], queryFn: () => get<{ slug: string | null }>('/api/public/host-page'), staleTime: Infinity, retry: false });
  if (host.isLoading) return <Loading />;
  if (host.data?.slug) return <Suspense fallback={<Loading />}><PublicStatus slug={host.data.slug} /></Suspense>;

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/status/:slug" element={<PublicStatus />} />
        <Route path="/kiosk" element={<Protected><Kiosk /></Protected>} />
        <Route element={<Protected />}>
          <Route index element={<Dashboard />} />
          <Route path="monitors/new" element={guard(<MonitorForm />, 'editor')} />
          <Route path="monitors/:id" element={<MonitorDetail />} />
          <Route path="monitors/:id/edit" element={guard(<MonitorForm />, 'editor')} />
          <Route path="incidents" element={<Incidents />} />
          <Route path="incidents/:id" element={<IncidentDetail />} />
          <Route path="maintenance" element={<Maintenance />} />
          <Route path="status-pages" element={<StatusPagesAdmin />} />
          <Route path="insights" element={<Insights />} />
          <Route path="reports" element={<Reports />} />
          <Route path="notifications" element={guard(<Notifications />, 'editor')} />
          <Route path="probes" element={guard(<Probes />, 'editor')} />
          <Route path="groups" element={guard(<Groups />, 'editor')} />
          <Route path="users" element={guard(<Users />, 'admin')} />
          <Route path="audit" element={guard(<Audit />, 'admin')} />
          <Route path="settings" element={guard(<Settings />, 'admin')} />
          <Route path="profile" element={<Profile />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
