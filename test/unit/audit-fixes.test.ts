import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRunner, NetGuard, type CheckResult } from '../../src/core';
import { assertBody } from '../../src/core/runners/http';
import { fmtPct } from '../../web/src/lib/format';

const open = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
const publicOnly = new NetGuard({ mode: 'public-only', allow: [], deny: [] });
const run = (type: string, config: Record<string, any>, guard = open, timeoutMs = 3000): Promise<CheckResult> =>
  getRunner(type)!.run({ config, timeoutMs, signal: AbortSignal.timeout(timeoutMs), guard, monitor: { id: 1, name: 't' } });

describe('checks stay behind the SSRF guard', () => {
  it('websocket refuses ws+unix:// (local sockets)', async () => {
    const r = await run('websocket', { url: 'ws+unix:///var/run/docker.sock:/containers/x/attach/ws' });
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('config');
  });

  it('dns refuses a resolver given as ip:port', async () => {
    const r = await run('dns', { host: 'example.com', resolver: '127.0.0.1:53' }, publicOnly);
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('config');
  });

  it('dns still blocks a private resolver in public-only mode', async () => {
    const r = await run('dns', { host: 'example.com', resolver: '127.0.0.1' }, publicOnly);
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('blocked');
  });
});

describe('docker check', () => {
  let srv: http.Server, port = 0;
  beforeAll(async () => {
    // announces a long body, sends a part of it and drops the connection
    srv = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('{"State":'); setTimeout(() => res.socket?.destroy(), 50); });
    port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
  });
  afterAll(() => { srv.closeAllConnections(); srv.close(); });

  it('fails instead of hanging when the API drops the connection mid-body', async () => {
    const started = Date.now();
    const r = await run('docker', { endpoint: `http://127.0.0.1:${port}`, container: 'web' }, open, 5000);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('keyword assertion', () => {
  const res = (body: string, truncated: boolean) => ({ body, truncated }) as Parameters<typeof assertBody>[0];
  it('cannot rule out an unwanted keyword in a response that was cut off', () => {
    expect(assertBody(res('all fine', true), { keyword: 'error', invert: true })?.kind).toBe('content');
    expect(assertBody(res('all fine', false), { keyword: 'error', invert: true })).toBeNull();
  });
});

describe('fmtPct', () => {
  it('only drops zeros behind the decimal point', () => {
    expect(fmtPct(100, 0)).toBe('100%');
    expect(fmtPct(100)).toBe('100%');
    expect(fmtPct(99.5)).toBe('99.5%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(null)).toBe('–');
  });
});
