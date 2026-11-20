// Live updates for a wall display opened with a kiosk key. EventSource cannot send headers, and the key must not go into the
// address (server and proxy logs), so the stream is read with fetch and parsed here.
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Beat, KioskView, Overlay, Status } from './api';

export const KIOSK_STREAM_URL = '/api/public/kiosk/stream';

/* ------------------------------ frame parser ------------------------------ */

export type SseFrame = { kind: 'event'; event: string; data: string } | { kind: 'comment'; text: string };

/**
 * Incremental parser for text/event-stream. Feed decoded chunks as they arrive (they may end anywhere, even between \r and \n);
 * it returns the frames completed so far. Lines end at \n, \r\n or \r; a blank line ends an event; data lines are joined with \n;
 * `:` lines are comments (the server's keep-alive pings). Unlike the spec, an event with a name but no data is still reported,
 * so a bare `event: config` triggers a refetch.
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buf = '', event = '', data: string[] = [], named = false;
  const line = (l: string, out: SseFrame[]) => {
    if (l === '') {
      if (data.length || named) out.push({ kind: 'event', event: event || 'message', data: data.join('\n') });
      event = ''; data = []; named = false;
      return;
    }
    if (l.startsWith(':')) { out.push({ kind: 'comment', text: l.slice(1).replace(/^ /, '') }); return; }
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    const value = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
    if (field === 'event') { event = value; named = true; } else if (field === 'data') data.push(value);
    // id and retry are not used: the client reconnects with its own backoff and refetches what it missed
  };
  return (chunk: string) => {
    const out: SseFrame[] = [];
    buf += chunk;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c !== '\n' && c !== '\r') continue;
      if (c === '\r' && i + 1 === buf.length) break; // may be the first half of \r\n: wait for the next chunk
      line(buf.slice(start, i), out);
      if (c === '\r' && buf[i + 1] === '\n') i++;
      start = i + 1;
    }
    buf = buf.slice(start);
    return out;
  };
}

/* ------------------------------ cache patching ------------------------------ */

/** The monitor event of the stream (same payload as on /api/stream). */
export interface KioskMonitorEvent {
  id: number; status: Status; overlay: Overlay; latencyMs: number | null; errorKind: string | null; message: string | null; ts: string;
  flapping?: boolean; statusSince: string | null; anomalyFlagged?: boolean; beat?: Beat;
}
const RECENT_MAX = 90;

/** The view with the events applied in order. Error texts stay hidden when the preset hides them, whatever the event carries. */
export function applyMonitorEvents(view: KioskView, events: readonly KioskMonitorEvent[]): KioskView {
  if (!events.length) return view;
  const byId = new Map<number, KioskMonitorEvent[]>();
  for (const e of events) { const l = byId.get(e.id); if (l) l.push(e); else byId.set(e.id, [e]); }
  const messages = view.preset.config.messages !== false;
  let touched = false;
  const monitors = view.monitors.map((m) => {
    const evs = byId.get(m.id);
    if (!evs) return m;
    touched = true;
    let cur = m;
    for (const d of evs) {
      cur = {
        ...cur, status: d.status, overlay: d.overlay, latencyMs: d.latencyMs, statusSince: d.statusSince, lastCheckAt: d.ts,
        message: messages ? d.message : null, errorKind: messages ? d.errorKind : null,
        recent: d.beat ? [...cur.recent, d.beat].slice(-RECENT_MAX) : cur.recent,
      };
    }
    return cur;
  });
  return touched ? { ...view, monitors } : view;
}

/* ------------------------------ connection ------------------------------ */

const BACKOFF_MIN = 3000, BACKOFF_MAX = 30_000;
const STABLE_MS = 30_000; // a connection held this long resets the backoff
const SILENT_MS = 45_000; // the server pings every 15 s: this long without a byte means the connection is dead
const UNAUTHORIZED_RETRY_MS = 60_000;
const BATCH_MS = 300;

/** Next wait before reconnecting after `attempts` failures; `rand` (0..1) spreads several screens apart. */
export const backoffDelay = (attempts: number, rand = Math.random()): number => Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempts) * (0.8 + rand * 0.4);

/**
 * Keeps the stream of a kiosk key open while mounted: monitor events patch the cached view under `viewKey`, `config` and
 * `incident` events refetch it, and so does every reconnect (events may have been missed). Reconnects with backoff.
 */
export function useKioskStream(kioskKey: string, viewKey: QueryKey): { connected: boolean; unauthorized: boolean } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const keyStr = JSON.stringify(viewKey);

  useEffect(() => {
    const vk = JSON.parse(keyStr) as QueryKey;
    let alive = true, running = false, attempts = 0, everOpened = false;
    let ctl: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined, stable: ReturnType<typeof setTimeout> | undefined;
    let silent: ReturnType<typeof setTimeout> | undefined, flushTimer: ReturnType<typeof setTimeout> | undefined, refetchTimer: ReturnType<typeof setTimeout> | undefined;
    let queue: KioskMonitorEvent[] = [];

    const refetchSoon = () => { refetchTimer ??= setTimeout(() => { refetchTimer = undefined; void qc.invalidateQueries({ queryKey: vk }); }, 500); };
    const flush = () => {
      flushTimer = undefined;
      const batch = queue; queue = [];
      if (batch.length) qc.setQueryData<KioskView>(vk, (v) => (v ? applyMonitorEvents(v, batch) : v));
    };
    const onFrame = (f: SseFrame) => {
      if (f.kind !== 'event') return;
      if (f.event === 'monitor') {
        try { queue.push(JSON.parse(f.data) as KioskMonitorEvent); } catch { return; }
        if (queue.length >= 200) { clearTimeout(flushTimer); flush(); } else flushTimer ??= setTimeout(flush, BATCH_MS);
      } else if (f.event === 'config' || f.event === 'incident') refetchSoon();
    };
    const schedule = (delay = backoffDelay(attempts++)) => { if (!alive) return; clearTimeout(retry); retry = setTimeout(() => void run(), delay); };
    const kick = () => { clearTimeout(silent); silent = setTimeout(() => ctl?.abort(), SILENT_MS); };

    const run = async () => {
      if (!alive || running) return;
      running = true;
      clearTimeout(retry);
      ctl = new AbortController();
      let wait: number | undefined;
      try {
        const res = await fetch(KIOSK_STREAM_URL, { headers: { 'x-kiosk-key': kioskKey, accept: 'text/event-stream' }, signal: ctl.signal, cache: 'no-store' });
        if (res.status === 401) { setUnauthorized(true); wait = UNAUTHORIZED_RETRY_MS; return; }
        if (!res.ok || !res.body) return;
        setUnauthorized(false);
        setConnected(true);
        // only a connection that holds resets the backoff: a server that accepts and drops at once must not cause a tight loop
        clearTimeout(stable); stable = setTimeout(() => { attempts = 0; }, STABLE_MS);
        if (everOpened) refetchSoon(); else everOpened = true;
        kick();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const parse = createSseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          for (const f of parse(dec.decode(value, { stream: true }))) onFrame(f);
        }
      } catch { /* network error or aborted: reconnect below */ } finally {
        running = false;
        clearTimeout(silent); clearTimeout(stable);
        if (alive) { setConnected(false); schedule(wait); }
      }
    };

    // back online or visible again while waiting for a retry: do not sit out the backoff
    const now = () => { if (alive && !running) { attempts = 0; void run(); } };
    const onVisible = () => { if (document.visibilityState === 'visible') now(); };
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', onVisible);
    void run();
    return () => {
      alive = false;
      clearTimeout(retry); clearTimeout(stable); clearTimeout(silent); clearTimeout(flushTimer); clearTimeout(refetchTimer);
      window.removeEventListener('online', now);
      document.removeEventListener('visibilitychange', onVisible);
      ctl?.abort();
      setConnected(false);
    };
  }, [kioskKey, keyStr, qc]);

  return { connected, unauthorized };
}
