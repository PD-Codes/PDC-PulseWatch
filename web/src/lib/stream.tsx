import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Beat, MonitorItem } from './api';

/** Live updates over Server-Sent Events. Monitor events patch the cached list in place, other events invalidate queries. */
const bus = new EventTarget();
export function subscribeStream<T = any>(type: string, fn: (data: T) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<T>).detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

const Conn = createContext<{ connected: boolean }>({ connected: false });
export const useStreamState = () => useContext(Conn);
const RECENT_MAX = 90;

export function StreamProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const pending = useRef<Set<string>>(new Set());

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let alive = true;
    // several events in a burst should trigger one refetch
    const invalidateSoon = (key: string) => {
      if (pending.current.has(key)) return;
      pending.current.add(key);
      setTimeout(() => { pending.current.delete(key); void qc.invalidateQueries({ queryKey: [key] }); }, 500);
    };
    const connect = () => {
      es = new EventSource('/api/stream');
      // events missed while disconnected: refetch everything that live updates keep fresh
      es.onopen = () => { setConnected(true); for (const k of ['monitors', 'monitor', 'incidents', 'timeline', 'maintenance']) void qc.invalidateQueries({ queryKey: [k] }); };
      es.onerror = () => { setConnected(false); es?.close(); if (alive) retry = setTimeout(connect, 3000); };
      es.addEventListener('monitor', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        const prev = qc.getQueryData<MonitorItem[]>(['monitors'])?.find((m) => m.id === d.id);
        qc.setQueryData<MonitorItem[]>(['monitors'], (list) => list?.map((m) => m.id !== d.id ? m : {
          ...m, status: d.status, overlay: d.overlay, latencyMs: d.latencyMs, errorKind: d.errorKind, message: d.message, lastCheckAt: d.ts, flapping: d.flapping, statusSince: d.statusSince, anomaly: d.anomalyFlagged,
          recent: d.beat ? [...m.recent, d.beat as Beat].slice(-RECENT_MAX) : m.recent,
        }));
        bus.dispatchEvent(new CustomEvent('monitor', { detail: d }));
        if (prev && (prev.status !== d.status || prev.statusSince !== d.statusSince)) invalidateSoon('timeline'); // every check carries statusSince, only a change matters
      });
      es.addEventListener('incident', (e) => { const d = JSON.parse((e as MessageEvent).data); invalidateSoon('incidents'); invalidateSoon('timeline'); bus.dispatchEvent(new CustomEvent('incident', { detail: d })); });
      es.addEventListener('maintenance', () => { invalidateSoon('maintenance'); invalidateSoon('monitors'); });
      es.addEventListener('config', () => { invalidateSoon('monitors'); invalidateSoon('groups'); invalidateSoon('tags'); });
    };
    connect();
    return () => { alive = false; clearTimeout(retry); es?.close(); setConnected(false); };
  }, [qc]);

  return <Conn.Provider value={{ connected }}>{children}</Conn.Provider>;
}
