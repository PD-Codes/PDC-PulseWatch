import { describe, expect, it } from 'vitest';
import type { KioskMonitor, KioskView } from '../../web/src/lib/api';
import { applyMonitorEvents, backoffDelay, createSseParser } from '../../web/src/lib/kioskStream';
import { KIOSK_DEFAULTS } from '../../src/core/kiosk';

describe('event stream parser', () => {
  it('parses named events and joins multi-line data', () => {
    const p = createSseParser();
    expect(p('event: monitor\ndata: {"a":1,\ndata: "b":2}\n\nevent: config\ndata: {}\n\n')).toEqual([
      { kind: 'event', event: 'monitor', data: '{"a":1,\n"b":2}' },
      { kind: 'event', event: 'config', data: '{}' },
    ]);
  });

  it('reports comments (the keep-alive pings) and ignores id and retry', () => {
    const p = createSseParser();
    expect(p(': ping\n\nid: 7\nretry: 1000\ndata: x\n\n')).toEqual([{ kind: 'comment', text: 'ping' }, { kind: 'event', event: 'message', data: 'x' }]);
  });

  it('keeps partial chunks until the frame is complete, including a CRLF split between chunks', () => {
    const p = createSseParser();
    expect(p('event: inci')).toEqual([]);
    expect(p('dent\r')).toEqual([]);
    expect(p('\ndata: {"id":3}\r\n')).toEqual([]);
    expect(p('\r\n')).toEqual([{ kind: 'event', event: 'incident', data: '{"id":3}' }]);
    expect(p('data:no space\r\rdata: a\n')).toEqual([{ kind: 'event', event: 'message', data: 'no space' }]);
    expect(p('\n')).toEqual([{ kind: 'event', event: 'message', data: 'a' }]);
  });

  it('reports a named event without data, but not an empty block', () => {
    const p = createSseParser();
    expect(p('event: hello\n\n\n\n')).toEqual([{ kind: 'event', event: 'hello', data: '' }]);
  });

  it('works byte by byte', () => {
    const p = createSseParser();
    const text = 'event: monitor\ndata: {"id":1}\n\n: ping\n\n';
    const out = [...text].flatMap((c) => p(c));
    expect(out).toEqual([{ kind: 'event', event: 'monitor', data: '{"id":1}' }, { kind: 'comment', text: 'ping' }]);
  });
});

describe('cache patch from monitor events', () => {
  const mon = (id: number, extra: Partial<KioskMonitor> = {}): KioskMonitor => ({
    id, name: `m${id}`, groupId: null, active: true, status: 'up', overlay: 'none', statusSince: null, lastCheckAt: null, latencyMs: 10, errorKind: null, message: null,
    recent: [], uptime: { h24: 100, d30: 100 }, info: null, ...extra,
  });
  const view = (messages: boolean): KioskView => ({ preset: { id: 1, slug: 'all', name: '', config: { ...KIOSK_DEFAULTS, messages } }, monitors: [mon(1), mon(2)], groups: [], incidents: [], serverTime: '' });
  const ev = { id: 1, status: 'down' as const, overlay: 'none' as const, latencyMs: null, errorKind: 'timeout', message: 'timed out', ts: '2026-11-20T08:00:00Z', statusSince: '2026-11-20T08:00:00Z', beat: [1, 0, null] as [number, number, null] };

  it('applies status, latency, since and the new beat; leaves other monitors untouched', () => {
    const v = view(true);
    const out = applyMonitorEvents(v, [ev]);
    expect(out.monitors[0]).toMatchObject({ status: 'down', latencyMs: null, message: 'timed out', statusSince: ev.statusSince, lastCheckAt: ev.ts, recent: [[1, 0, null]] });
    expect(out.monitors[1]).toBe(v.monitors[1]);
    expect(applyMonitorEvents(v, [])).toBe(v);
  });

  it('keeps error texts hidden when the preset hides them', () => {
    expect(applyMonitorEvents(view(false), [ev]).monitors[0]).toMatchObject({ message: null, errorKind: null });
  });
});

describe('reconnect backoff', () => {
  it('starts at 3 s, doubles, and stops at 30 s', () => {
    expect(backoffDelay(0, 0.5)).toBe(3000);
    expect(backoffDelay(1, 0.5)).toBe(6000);
    expect(backoffDelay(10, 0.5)).toBe(30_000);
  });
});
