import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, get, type Beat, type MonitorItem } from './api';

/**
 * Live updates over Server-Sent Events. Monitor events patch the cached list in place (batched), other events invalidate queries.
 * Bus events: 'monitor', 'incident', and 'reconnect' (the stream came back after a gap).
 */
const bus = new EventTarget();
export function subscribeStream<T = any>(type: string, fn: (data: T) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<T>).detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

const Conn = createContext<{ connected: boolean }>({ connected: false });
export const useStreamState = () => useContext(Conn);
const RECENT_MAX = 90;
const BACKOFF_MIN = 3000, BACKOFF_MAX = 30_000;
const STABLE_MS = 30_000; // a connection open this long counts as healthy
const BATCH_MS = 300; // monitor events inside this window are applied to the cache in one go
const RESYNC_MIN_GAP = 10_000; // at most one full refetch per this many ms, however often the stream flaps
const RESYNC_KEYS = ['monitors', 'monitor', 'incidents', 'timeline', 'maintenance'];

type MonitorEvent = { id: number; status: MonitorItem['status']; overlay: MonitorItem['overlay']; latencyMs: number | null; errorKind: string | null; message: string | null; ts: string; flapping: boolean; statusSince: string | null; anomalyFlagged: boolean; beat?: Beat };

export function StreamProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let attempts = 0; // failures since the last connection that held
    let stable: ReturnType<typeof setTimeout> | undefined;
    let everOpened = false;
    let lastSync = 0;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let queue: MonitorEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    // several events in a burst should trigger one refetch
    const invalidateSoon = (key: string) => {
      if (pending.has(key)) return;
      pending.add(key);
      setTimeout(() => { pending.delete(key); void qc.invalidateQueries({ queryKey: [key] }); }, 500);
    };

    // events missed while disconnected: refetch what live updates keep fresh, but not more often than every RESYNC_MIN_GAP
    const resync = () => {
      if (syncTimer) return;
      const wait = Math.max(0, lastSync + RESYNC_MIN_GAP - Date.now());
      syncTimer = setTimeout(() => { syncTimer = undefined; lastSync = Date.now(); for (const k of RESYNC_KEYS) void qc.invalidateQueries({ queryKey: [k] }); }, wait);
    };

    const flush = () => {
      flushTimer = undefined;
      const batch = queue;
      queue = [];
      if (!batch.length) return;
      const byId = new Map<number, MonitorEvent[]>();
      for (const d of batch) { const l = byId.get(d.id); if (l) l.push(d); else byId.set(d.id, [d]); }
      let changed = false;
      qc.setQueryData<MonitorItem[]>(['monitors'], (list) => list?.map((m) => {
        const evs = byId.get(m.id);
        if (!evs) return m;
        let cur = m;
        for (const d of evs) {
          if (cur.status !== d.status || cur.statusSince !== d.statusSince) changed = true; // every check carries statusSince, only a change matters
          cur = {
            ...cur, status: d.status, overlay: d.overlay, latencyMs: d.latencyMs, errorKind: d.errorKind, message: d.message, lastCheckAt: d.ts, flapping: d.flapping, statusSince: d.statusSince, anomaly: d.anomalyFlagged,
            recent: d.beat ? [...cur.recent, d.beat].slice(-RECENT_MAX) : cur.recent,
          };
        }
        return cur;
      }));
      if (changed) invalidateSoon('timeline');
    };

    const schedule = () => {
      if (!alive) return;
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempts * (0.8 + Math.random() * 0.4));
      attempts++;
      clearTimeout(retry);
      retry = setTimeout(connect, delay);
    };

    // a 401 on the stream reaches the page only as a generic error: ask the session endpoint (api() raises pw:unauthorized on a 401)
    const afterError = async () => {
      try { await get('/api/auth/me', { timeoutMs: 10_000 }); } catch (e) { if (e instanceof ApiError && e.status === 401) return; }
      if (!alive || es) return; // closed meanwhile, or something already reconnected
      if (navigator.onLine === false) return; // the 'online' listener reconnects
      schedule();
    };

    const connect = () => {
      if (!alive) return;
      clearTimeout(retry);
      es?.close();
      es = new EventSource('/api/stream');
      es.onopen = () => {
        setConnected(true);
        // a server that accepts and drops at once must not reset the backoff: only a connection that holds does
        clearTimeout(stable);
        stable = setTimeout(() => { attempts = 0; }, STABLE_MS);
        if (everOpened) { bus.dispatchEvent(new Event('reconnect')); resync(); } else { everOpened = true; lastSync = Date.now(); }
      };
      es.onerror = () => { clearTimeout(stable); setConnected(false); es?.close(); es = null; void afterError(); };
      es.addEventListener('monitor', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as MonitorEvent;
        bus.dispatchEvent(new CustomEvent('monitor', { detail: d }));
        queue.push(d);
        if (queue.length >= 200) { clearTimeout(flushTimer); flush(); } else flushTimer ??= setTimeout(flush, BATCH_MS);
      });
      es.addEventListener('incident', (e) => { const d = JSON.parse((e as MessageEvent).data); invalidateSoon('incidents'); invalidateSoon('timeline'); bus.dispatchEvent(new CustomEvent('incident', { detail: d })); });
      es.addEventListener('maintenance', () => { invalidateSoon('maintenance'); invalidateSoon('monitors'); });
      es.addEventListener('config', () => { invalidateSoon('monitors'); invalidateSoon('groups'); invalidateSoon('tags'); });
    };

    // back online or tab visible again while waiting for a retry: do not sit out the backoff
    const reconnectNow = () => { if (alive && !es) { attempts = 0; connect(); } };
    const onVisible = () => { if (document.visibilityState === 'visible') reconnectNow(); };
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisible);
    connect();
    return () => {
      alive = false;
      clearTimeout(retry); clearTimeout(flushTimer); clearTimeout(syncTimer); clearTimeout(stable);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible);
      es?.close();
      setConnected(false);
    };
  }, [qc]);

  return <Conn.Provider value={{ connected }}>{children}</Conn.Provider>;
}
