import fs from 'node:fs';
import https from 'node:https';
import type net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getRunner, NetGuard, setExtraCa } from '../../src/core';
import { tlsMessage, type TlsFacts } from '../../src/core/tlsdetail';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, '../fixtures', f));
const guard = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
const run = (type: string, config: Record<string, any>) => getRunner(type)!.run({ config, timeoutMs: 3000, signal: AbortSignal.timeout(3000), guard, monitor: { id: 1, name: 't' } });

let srv: https.Server; let port = 0;
beforeAll(async () => {
  srv = https.createServer({ key: fx('localhost.key'), cert: fx('localhost.crt') }, (_q, res) => res.end('ok'));
  port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
});
afterEach(() => setExtraCa([]));
afterAll(() => srv.close());

const facts = (over: Partial<TlsFacts>): TlsFacts => ({ host: 'a.example.com', port: 443, subject: 'CN=a.example.com', issuer: 'CN=Test CA', validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', daysLeft: 90, altNames: [], fingerprint256: 'AA', selfSigned: false, ...over });

describe('tlsMessage', () => {
  it('names expiry date, subject, issuer, host and code', () => {
    const m = tlsMessage(facts({ validTo: '2026-01-02T00:00:00Z', code: 'CERT_HAS_EXPIRED' }));
    expect(m).toMatch(/expired on 2026-01-02 \(\d+ days? ago\)/);
    expect(m).toContain('CN=a.example.com');
    expect(m).toContain('issuer CN=Test CA');
    expect(m).toContain('host a.example.com:443');
    expect(m).toContain('(CERT_HAS_EXPIRED)');
  });
  it('names both problems when a certificate is expired and for another host', () => {
    const m = tlsMessage(facts({ validTo: '2026-01-02T00:00:00Z', code: 'CERT_HAS_EXPIRED', nameMatches: false, altNames: ['DNS:other.example.com'] }));
    expect(m).toMatch(/expired on 2026-01-02 \(\d+ days? ago\) and does not match a\.example\.com \(valid for DNS:other\.example\.com\)/);
  });
  it('lists the names a mismatching certificate is valid for', () => {
    expect(tlsMessage(facts({ nameMatches: false, servername: 'b.example.com', altNames: ['DNS:a.example.com'] }))).toContain('does not match b.example.com (valid for DNS:a.example.com)');
  });
});

describe('tls runner with imported CA', () => {
  const cfg = () => ({ host: '127.0.0.1', port, servername: 'localhost', warnDays: 0 });
  it('explains an untrusted certificate, then trusts it after the CA import', async () => {
    const bad = await run('tls', cfg());
    expect(bad).toMatchObject({ ok: false, errorKind: 'tls' });
    expect(bad.message).toContain('CN=localhost');
    expect(bad.message).toContain(`host 127.0.0.1:${port}`);
    expect(bad.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
    setExtraCa([fx('localhost.crt').toString()]);
    expect(await run('tls', cfg())).toMatchObject({ ok: true });
  });
  it('is also trusted by the http runner', async () => {
    const url = `https://localhost:${port}/`;
    const g = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
    const r = () => getRunner('http')!.run({ config: { url }, timeoutMs: 3000, signal: AbortSignal.timeout(3000), guard: g, monitor: { id: 1, name: 't' } });
    const bad = await r();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('CN=localhost');
    setExtraCa([fx('localhost.crt').toString()]);
    expect((await r()).ok).toBe(true);
  });
});
