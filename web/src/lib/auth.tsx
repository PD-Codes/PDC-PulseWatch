import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, get, post, setCsrf, type Me, type Meta } from './api';
import { LocaleProvider } from './i18n';
import { isThemeId, setDefaultTheme, setMode, setTheme, setThemeId } from './theme';

/** What /api/auth/me and /api/meta carry beyond the base types: the person's own theme and the instance default. */
export type MeX = Me & { uiTheme?: string | null };
export type MetaX = Meta & { defaultTheme?: string | null };

// Per-device theme choice (set by theme.ts) and the theme the server last told this device to use.
const DEVICE_THEME_KEY = 'pw.theme.id';
const FROM_SERVER_KEY = 'pw.theme.fromServer';
const DEVICE_MODE_KEY = 'pw.theme';
const MODE_FROM_SERVER_KEY = 'pw.theme.modeFromServer';
const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove(k: string) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

/** Back to the instance default on this device: the stored choice goes away (theme.ts has no call for that, so set it, repaint, then remove it). */
function dropDeviceTheme() {
  const d = ls.get('pw.theme.default');
  setThemeId(isThemeId(d) ? d : 'classic'); // repaints with what the fallback resolves to anyway
  ls.remove(DEVICE_THEME_KEY);
  ls.remove(FROM_SERVER_KEY);
}
function dropDeviceMode() {
  setMode('system');
  ls.remove(DEVICE_MODE_KEY);
  ls.remove(MODE_FROM_SERVER_KEY);
}

/** The person chose "instance default" in the profile: this device forgets its theme too. */
export function clearDeviceTheme() { dropDeviceTheme(); }

/** Signed out or session gone: what the previous person's profile put on this device must not carry over to the next one. */
export function forgetServerAppearance() {
  if (ls.get(DEVICE_THEME_KEY) && ls.get(DEVICE_THEME_KEY) === ls.get(FROM_SERVER_KEY)) dropDeviceTheme(); else ls.remove(FROM_SERVER_KEY);
  if (ls.get(DEVICE_MODE_KEY) && ls.get(DEVICE_MODE_KEY) === ls.get(MODE_FROM_SERVER_KEY)) dropDeviceMode(); else ls.remove(MODE_FROM_SERVER_KEY);
}

/**
 * The theme from the person's profile applies on a device that has no choice of its own, and on one that only holds
 * what an earlier profile value put there, so a change made in the profile on another device arrives here too.
 */
export function applyProfileTheme(uiTheme: string | null | undefined) {
  const own = ls.get(DEVICE_THEME_KEY);
  // a profile without a theme (new person in the same browser): what the previous profile put here goes back to the instance default
  if (!isThemeId(uiTheme)) { if (own && own === ls.get(FROM_SERVER_KEY)) dropDeviceTheme(); return; }
  if (own && own !== ls.get(FROM_SERVER_KEY)) return; // the person picked a theme on this device
  ls.set(FROM_SERVER_KEY, uiTheme);
  if (own !== uiTheme) setThemeId(uiTheme);
}

// Same rule for light/dark/system: the mode stored in the profile must not undo a mode picked on this device (top bar, kiosk).
export function applyProfileMode(mode: string | null | undefined) {
  if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
  const own = ls.get(DEVICE_MODE_KEY);
  if (own && own !== ls.get(MODE_FROM_SERVER_KEY)) return; // the person picked a mode on this device
  ls.set(MODE_FROM_SERVER_KEY, mode);
  if (own !== mode) setTheme(mode);
}

/** After the profile theme was saved from this device: it is the server's value now, not a device choice of its own. */
export function rememberProfileTheme(themeId: string, mode?: string) { ls.set(FROM_SERVER_KEY, themeId); if (mode) ls.set(MODE_FROM_SERVER_KEY, mode); }

interface AuthCtx { user: MeX | null; loading: boolean; refresh: () => Promise<void>; login: (b: { username: string; password: string; totp?: string }) => Promise<void>; logout: () => Promise<void>; afterLogin: (csrf?: string) => Promise<void>; can: (role: 'editor' | 'admin') => boolean }
const Auth = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => { try { const u = await get<MeX>('/api/auth/me'); if (u.csrf) setCsrf(u.csrf); return u; } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } },
  });
  const user = me.data ?? null;

  useEffect(() => { applyProfileMode(user?.theme); }, [user?.theme]);
  // runs for each person who signs in, also when two people in a row have no theme of their own
  useEffect(() => { if (user) applyProfileTheme(user.uiTheme ?? null); }, [user?.id, user?.uiTheme]); // eslint-disable-line react-hooks/exhaustive-deps
  // the instance default theme: used on devices without their own choice
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => get<MetaX>('/api/meta'), staleTime: 3_600_000 }).data;
  useEffect(() => { if (meta && 'defaultTheme' in meta) setDefaultTheme(isThemeId(meta.defaultTheme) ? meta.defaultTheme : null); }, [meta]);
  useEffect(() => {
    const onUnauthorized = () => { setCsrf(''); qc.setQueryData(['me'], null); forgetServerAppearance(); };
    window.addEventListener('pw:unauthorized', onUnauthorized);
    return () => window.removeEventListener('pw:unauthorized', onUnauthorized);
  }, [qc]);

  const refresh = useCallback(async () => { await qc.invalidateQueries({ queryKey: ['me'] }); }, [qc]);
  const afterLogin = useCallback(async (csrf?: string) => { if (csrf) setCsrf(csrf); await qc.invalidateQueries({ queryKey: ['me'] }); }, [qc]);
  const login = useCallback(async (b: { username: string; password: string; totp?: string }) => { const r = await post<{ csrf: string }>('/api/auth/login', b); await afterLogin(r.csrf); }, [afterLogin]);
  const logout = useCallback(async () => { try { await post('/api/auth/logout'); } finally { setCsrf(''); forgetServerAppearance(); qc.clear(); qc.setQueryData(['me'], null); } }, [qc]);
  const rank = { viewer: 0, editor: 1, admin: 2 } as const;
  const can = useCallback((role: 'editor' | 'admin') => !!user && rank[user.role] >= rank[role], [user]);

  return (
    <LocaleProvider preferred={user?.locale}>
      <Auth.Provider value={{ user, loading: me.isLoading, refresh, login, logout, afterLogin, can }}>{children}</Auth.Provider>
    </LocaleProvider>
  );
}

export const useAuth = () => useContext(Auth);
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => get<MetaX>('/api/meta'), staleTime: 3_600_000 }).data;
