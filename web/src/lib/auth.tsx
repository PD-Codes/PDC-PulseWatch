import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, get, post, setCsrf, type Me, type Meta } from './api';
import { LocaleProvider } from './i18n';
import { setTheme } from './theme';

interface AuthCtx { user: Me | null; loading: boolean; refresh: () => Promise<void>; login: (b: { username: string; password: string; totp?: string }) => Promise<void>; logout: () => Promise<void>; afterLogin: (csrf?: string) => Promise<void>; can: (role: 'editor' | 'admin') => boolean }
const Auth = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => { try { const u = await get<Me>('/api/auth/me'); if (u.csrf) setCsrf(u.csrf); return u; } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } },
  });
  const user = me.data ?? null;

  useEffect(() => { if (user?.theme) setTheme(user.theme); }, [user?.theme]);
  useEffect(() => {
    const onUnauthorized = () => { setCsrf(''); qc.setQueryData(['me'], null); };
    window.addEventListener('pw:unauthorized', onUnauthorized);
    return () => window.removeEventListener('pw:unauthorized', onUnauthorized);
  }, [qc]);

  const refresh = useCallback(async () => { await qc.invalidateQueries({ queryKey: ['me'] }); }, [qc]);
  const afterLogin = useCallback(async (csrf?: string) => { if (csrf) setCsrf(csrf); await qc.invalidateQueries({ queryKey: ['me'] }); }, [qc]);
  const login = useCallback(async (b: { username: string; password: string; totp?: string }) => { const r = await post<{ csrf: string }>('/api/auth/login', b); await afterLogin(r.csrf); }, [afterLogin]);
  const logout = useCallback(async () => { try { await post('/api/auth/logout'); } finally { setCsrf(''); qc.clear(); qc.setQueryData(['me'], null); } }, [qc]);
  const rank = { viewer: 0, editor: 1, admin: 2 } as const;
  const can = useCallback((role: 'editor' | 'admin') => !!user && rank[user.role] >= rank[role], [user]);

  return (
    <LocaleProvider preferred={user?.locale}>
      <Auth.Provider value={{ user, loading: me.isLoading, refresh, login, logout, afterLogin, can }}>{children}</Auth.Provider>
    </LocaleProvider>
  );
}

export const useAuth = () => useContext(Auth);
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => get<Meta>('/api/meta'), staleTime: 3_600_000 }).data;
