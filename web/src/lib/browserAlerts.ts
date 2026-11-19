import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Overlay, Status } from './api';
import { useT } from './i18n';
import { snoozeActive, type MonitorX } from './monitorExtras';
import { subscribeStream } from './stream';

/**
 * Desktop notifications for status changes while a PulseWatch tab is open (Notification API, no push server).
 * Only one tab per browser shows them: the holder of a Web Lock (navigator.locks), or where that is missing, of a lease in
 * localStorage that is checked afresh for every event (background tabs throttle timers, so a cached answer goes stale).
 * A short-lived "already announced" key keeps two tabs from announcing the same change twice during a handover.
 * Snoozed monitors stay quiet; maintenance and suppressed states never alert.
 */

export type BrowserAlertMode = 'off' | 'down' | 'all';
export type BrowserAlertSound = 'on' | 'off';
export const MODE_KEY = 'pw.notify.browser';
export const SOUND_KEY = 'pw.notify.sound';
export const LEADER_KEY = 'pw.notify.leader';
export const SEEN_KEY = 'pw.notify.seen';
const LOCK_NAME = 'pw-notify-leader';
export const LEASE_MS = 15_000;
const RENEW_MS = 5_000;
const CHANGED = 'pw:notify-settings';

const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export const readMode = (): BrowserAlertMode => { const v = ls.get(MODE_KEY); return v === 'down' || v === 'all' ? v : 'off'; };
export const readSound = (): BrowserAlertSound => (ls.get(SOUND_KEY) === 'on' ? 'on' : 'off');
export const alertsSupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;
const permissionNow = (): NotificationPermission => (alertsSupported() ? Notification.permission : 'denied');

/* ------------------------------- pure logic (unit-tested) ------------------------------- */

export interface Lease { id: string; ts: number }

export function parseLease(raw: string | null): Lease | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v.id === 'string' && Number.isFinite(v.ts) ? { id: v.id, ts: v.ts } : null; } catch { return null; }
}

/** May tab `me` take or keep the lease? Yes when nobody holds it, it is ours, or the holder stopped renewing it. */
export const claimLease = (cur: Lease | null, me: string, now: number, ttl = LEASE_MS): boolean => !cur || cur.id === me || now - cur.ts > ttl;

/** Was this event (same key) already announced by another tab within `windowMs`? */
export function seenRecently(raw: string | null, key: string, now: number, windowMs = 60_000): boolean {
  if (!raw) return false;
  try { const v = JSON.parse(raw); return v?.key === key && Number.isFinite(v.ts) && now - v.ts < windowMs; } catch { return false; }
}

/**
 * Which alert a status event causes. `prev` is the status before the event (undefined: unknown, then nothing is said,
 * so a reconnect does not repeat old outages). Recoveries are reported only in mode 'all' and only after a down.
 */
export function alertKind(prev: Status | undefined, next: { status: Status; overlay: Overlay }, mode: BrowserAlertMode, snoozed: boolean): 'down' | 'up' | null {
  if (mode === 'off' || snoozed || prev === undefined || next.overlay !== 'none') return null;
  if (next.status === 'down' && prev !== 'down') return 'down';
  if (mode === 'all' && next.status === 'up' && prev === 'down') return 'up';
  return null;
}

/* ------------------------------------- side effects ------------------------------------- */

/** Ask for permission (must run inside a click or key handler). Resolves 'denied' where the API is missing. */
export async function requestBrowserAlerts(): Promise<NotificationPermission> {
  if (!alertsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

let audio: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    audio ??= new AC();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    return audio;
  } catch { return null; }
}

/** Short two-tone chime made with Web Audio: falling for down, rising for up. */
export function playAlertSound(kind: 'down' | 'up' = 'down') {
  const ctx = audioCtx();
  if (!ctx) return;
  const tones = kind === 'down' ? [880, 587] : [587, 880];
  tones.forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    const t0 = ctx.currentTime + i * 0.17;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    o.connect(g).connect(ctx.destination);
    o.start(t0); o.stop(t0 + 0.16);
  });
}

/** Show one notification; falls back to the service worker where `new Notification` is not allowed (Android). */
export function showBrowserAlert(title: string, body: string, opts: { tag?: string; onClick?: () => void } = {}) {
  if (permissionNow() !== 'granted') return;
  const options: NotificationOptions = { body, tag: opts.tag, icon: '/icon.svg' };
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); opts.onClick?.(); n.close(); };
  } catch {
    void navigator.serviceWorker?.getRegistration().then((r) => r?.showNotification(title, options)).catch(() => {});
  }
}

/** Settings for the profile page; changes apply to all open tabs at once. Choosing a mode other than 'off' asks for permission. */
export function useBrowserAlertSettings() {
  const [mode, setModeState] = useState<BrowserAlertMode>(readMode);
  const [sound, setSoundState] = useState<BrowserAlertSound>(readSound);
  const [permission, setPermission] = useState<NotificationPermission>(permissionNow);
  useEffect(() => {
    const sync = () => { setModeState(readMode()); setSoundState(readSound()); setPermission(permissionNow()); };
    const onStorage = (e: StorageEvent) => { if (e.key === MODE_KEY || e.key === SOUND_KEY) sync(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener(CHANGED, sync);
    window.addEventListener('focus', sync); // permission may have changed in the browser settings
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGED, sync); window.removeEventListener('focus', sync); };
  }, []);
  const request = useCallback(async () => { const p = await requestBrowserAlerts(); setPermission(p); return p; }, []);
  const setMode = useCallback((m: BrowserAlertMode) => {
    ls.set(MODE_KEY, m === 'off' ? null : m);
    window.dispatchEvent(new Event(CHANGED));
    if (m !== 'off' && permissionNow() === 'default') void request();
  }, [request]);
  const setSound = useCallback((s: BrowserAlertSound) => {
    ls.set(SOUND_KEY, s === 'on' ? 'on' : null);
    window.dispatchEvent(new Event(CHANGED));
    if (s === 'on') playAlertSound('down'); // preview, and unlocks audio inside the click
  }, []);
  return { supported: alertsSupported(), permission, mode, sound, setMode, setSound, request };
}

interface MonitorEvent { id: number; status: Status; overlay: Overlay; errorKind: string | null; message: string | null; ts?: string }

/** Listens to the live stream and raises desktop notifications. Mount once, inside the signed-in layout. */
export function useBrowserAlerts() {
  const qc = useQueryClient();
  const t = useT();
  const nav = useNavigate();
  const latest = useRef({ t, nav });
  latest.current = { t, nav };

  useEffect(() => {
    const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Web Locks: exactly one tab holds the lock, the browser hands it on when that tab closes; timers play no part
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    let lockHeld = false;
    let releaseLock: (() => void) | undefined;
    const abort = new AbortController();
    if (locks) {
      void locks.request(LOCK_NAME, { signal: abort.signal }, () => new Promise<void>((resolve) => { lockHeld = true; releaseLock = resolve; })).catch(() => { /* aborted on unmount */ });
    }
    // fallback lease, renewed by a timer but checked again in the event handler itself
    const renew = (): boolean => {
      const now = Date.now();
      if (claimLease(parseLease(ls.get(LEADER_KEY)), me, now)) ls.set(LEADER_KEY, JSON.stringify({ id: me, ts: now }));
      return parseLease(ls.get(LEADER_KEY))?.id === me; // two tabs racing: the last writer wins
    };
    const isLeader = () => (locks ? lockHeld : renew());
    if (!locks) renew();
    const timer = locks ? undefined : setInterval(renew, RENEW_MS);
    const releaseLease = () => { if (parseLease(ls.get(LEADER_KEY))?.id === me) ls.set(LEADER_KEY, null); };
    const release = () => { if (locks) { lockHeld = false; releaseLock?.(); abort.abort(); } else releaseLease(); };
    // the browser drops a Web Lock with the page by itself; the lease has to be handed back
    const onHide = () => { if (!locks) releaseLease(); };
    window.addEventListener('pagehide', onHide);

    // browsers allow audio only after a gesture: open the audio context on the first one
    const unlock = () => { if (readSound() === 'on' && readMode() !== 'off') audioCtx(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    const last = new Map<number, Status>();
    const off = subscribeStream<MonitorEvent>('monitor', (e) => {
      const m = qc.getQueryData<MonitorX[]>(['monitors'])?.find((x) => x.id === e.id);
      const prev = last.get(e.id) ?? m?.status; // the cached list still holds the old status: it is patched after this event
      last.set(e.id, e.status);
      const mode = readMode();
      if (mode === 'off') return;
      const kind = alertKind(prev, e, mode, snoozeActive(m));
      if (!kind || !isLeader()) return;
      const key = `${e.id}:${kind}:${e.ts ?? ''}`;
      if (seenRecently(ls.get(SEEN_KEY), key, Date.now())) return;
      ls.set(SEEN_KEY, JSON.stringify({ key, ts: Date.now() }));
      const { t: tr, nav: go } = latest.current;
      const name = m?.name ?? `#${e.id}`;
      const body = kind === 'down' ? [e.errorKind, e.message].filter(Boolean).join(': ') || tr('mux.alert.downBody') : tr('mux.alert.upBody');
      showBrowserAlert(tr(kind === 'down' ? 'mux.alert.down' : 'mux.alert.up', { name }), body, { tag: `pw-monitor-${e.id}`, onClick: () => go(`/monitors/${e.id}`) });
      if (readSound() === 'on') playAlertSound(kind);
    });
    return () => {
      off(); if (timer) clearInterval(timer); release();
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [qc]);
}
