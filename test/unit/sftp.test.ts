import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server, utils, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRunner, NetGuard, type CheckResult } from '../../src/core';
import { normalizeFingerprint } from '../../src/core/runners/sftp';

const parse = (k: string) => { const p = utils.parseKey(k); if (p instanceof Error) throw p; return Array.isArray(p) ? p[0]! : p; };
const hostPair = utils.generateKeyPairSync('ed25519');
const hostFp = createHash('sha256').update(parse(hostPair.public).getPublicSSH()).digest('hex');
const userKey = utils.generateKeyPairSync('ed25519');
const userPub = parse(userKey.public);

const NOW = Math.floor(Date.now() / 1000);
// path -> [size, mtime(s), isDir]
const tree: Record<string, [number, number, boolean]> = { '/': [0, NOW, true], '/backup': [0, NOW, true], '/backup/new.tgz': [4096, NOW - 60, false], '/backup/old.tgz': [10, NOW - 7200, false], '/stale': [0, NOW, true], '/stale/x.tgz': [10, NOW - 7200, false], '/empty': [0, NOW, true] };
const attrs = ([size, mtime, dir]: [number, number, boolean]) => ({ mode: dir ? 0o040755 : 0o100644, uid: 0, gid: 0, size, atime: mtime, mtime });

let srv: Server;
let port = 0;
const guard = new NetGuard({ mode: 'allow-private', allow: [], deny: [] });
const run = (config: Record<string, any>, timeoutMs = 5000): Promise<CheckResult> =>
  getRunner('sftp')!.run({ config: { host: '127.0.0.1', port, username: 'bob', authMethod: 'password', password: 'pw', ...config }, timeoutMs, signal: AbortSignal.timeout(timeoutMs), guard, monitor: { id: 1, name: 't' } });

beforeAll(async () => {
  srv = new Server({ hostKeys: [hostPair.private] }, (client: Connection) => {
    client.on('error', () => {}); // a client that aborts the handshake (pinned key mismatch) must not crash the test server
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'bob') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'pw') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.algo === userPub.type && Buffer.compare(ctx.key.data, userPub.getPublicSSH()) === 0) return ctx.accept();
      return ctx.reject(['password', 'publickey']);
    }).on('ready', () => {
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const dirs = new Map<string, string>();
          let n = 0;
          const S = utils.sftp.STATUS_CODE;
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p, longname: p, attrs: {} as any }]));
          const stat = (id: number, p: string) => (tree[p] ? sftp.attrs(id, attrs(tree[p]!)) : sftp.status(id, S.NO_SUCH_FILE));
          sftp.on('STAT', stat).on('LSTAT', stat);
          sftp.on('OPENDIR', (id, p) => { if (!tree[p]?.[2]) return sftp.status(id, S.NO_SUCH_FILE); const h = Buffer.from(String(++n)); dirs.set(h.toString(), p); sftp.handle(id, h); });
          sftp.on('READDIR', (id, h) => {
            const p = dirs.get(h.toString());
            if (!p || dirs.get(`${h}:done`)) return sftp.status(id, S.EOF);
            dirs.set(`${h}:done`, '1');
            const kids = Object.keys(tree).filter((k) => k !== p && k.startsWith(p === '/' ? '/' : `${p}/`) && !k.slice(p.length + 1).includes('/'));
            sftp.name(id, kids.map((k) => ({ filename: k.split('/').pop()!, longname: k, attrs: attrs(tree[k]!) })));
          });
          sftp.on('CLOSE', (id) => sftp.status(id, S.OK));
        });
      });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as AddressInfo).port;
});
afterAll(() => { srv?.close(); });

describe('sftp runner', () => {
  it('logs in with a password and reports the host key', async () => {
    const r = await run({});
    expect(r).toMatchObject({ ok: true, message: 'SFTP login succeeded' });
    expect(normalizeFingerprint(String(r.details!.hostKey))).toBe(hostFp);
  });
  it('logs in with a private key', async () => {
    expect(await run({ authMethod: 'key', privateKey: userKey.private })).toMatchObject({ ok: true });
  });
  it('rejects wrong credentials', async () => {
    expect(await run({ password: 'nope' })).toMatchObject({ ok: false, errorKind: 'auth' });
  });
  it('enforces a pinned host key in both notations', async () => {
    expect(await run({ hostKey: `SHA256:${Buffer.from(hostFp, 'hex').toString('base64')}` })).toMatchObject({ ok: true });
    expect(await run({ hostKey: hostFp })).toMatchObject({ ok: true });
    expect(await run({ hostKey: `SHA256:${Buffer.alloc(32).toString('base64')}` })).toMatchObject({ ok: false, errorKind: 'tls' });
    // a pin that is not a SHA-256 fingerprint must fail the check instead of accepting any key
    for (const bad of ['SHA256:', 'SHA256:AAAA', '   x   ']) expect(await run({ hostKey: bad })).toMatchObject({ ok: false, errorKind: 'config' });
  });
  it('checks path, size and age', async () => {
    expect(await run({ path: '/backup' })).toMatchObject({ ok: true, details: { entries: 2 } });
    expect(await run({ path: '/backup/new.tgz', minSize: 1000, maxAgeMin: 30 })).toMatchObject({ ok: true });
    expect(await run({ path: '/backup/new.tgz', minSize: 10_000 })).toMatchObject({ ok: false, errorKind: 'content' });
    expect((await run({ path: '/backup/old.tgz', maxAgeMin: 30 })).message).toMatch(/last modified 1\d\d min ago/);
    expect((await run({ path: '/missing' })).message).toMatch(/not found/);
    // a directory is judged by its newest entry
    expect(await run({ path: '/backup', maxAgeMin: 30 })).toMatchObject({ ok: true });
    expect((await run({ path: '/stale', maxAgeMin: 30 })).message).toMatch(/Newest entry in \/stale was last modified/);
    expect((await run({ path: '/empty', maxAgeMin: 30 })).message).toMatch(/is empty/);
  });
  it('refuses an unusable private key before connecting', async () => {
    expect(await run({ authMethod: 'key', privateKey: 'not a key' })).toMatchObject({ ok: false, errorKind: 'config' });
    expect(await run({ authMethod: 'key', privateKey: '' })).toMatchObject({ ok: false, errorKind: 'config' });
  });
  it('is blocked by the SSRF guard and reports a closed port', async () => {
    const g = new NetGuard({ mode: 'public-only', allow: [], deny: [] });
    expect(await getRunner('sftp')!.run({ config: { host: '127.0.0.1', port, username: 'bob', password: 'pw' }, timeoutMs: 2000, signal: AbortSignal.timeout(2000), guard: g, monitor: { id: 1, name: 't' } })).toMatchObject({ ok: false, errorKind: 'blocked' });
    expect(await run({ port: 1 })).toMatchObject({ ok: false, errorKind: 'refused' });
  });
});
