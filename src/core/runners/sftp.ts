import ssh2, { type SFTPWrapper, type Stats } from 'ssh2';

// ssh2 is CommonJS, so Node's ESM loader (the built server) cannot see named exports; take them from the default export.
const { Client, utils } = ssh2;
import { connect } from '../conn';
import type { Runner } from '../types';
import { fail, hrMs, ok, toCheckError } from '../util';

/** ssh-keygen prints "SHA256:<base64>"; ssh2 hands us the hex digest. Accept both notations (and colon-separated hex). */
export function normalizeFingerprint(fp: string): string {
  const s = fp.trim();
  if (/^sha256:/i.test(s)) return Buffer.from(s.slice(7), 'base64').toString('hex');
  return s.replace(/:/g, '').toLowerCase();
}
const sha256Label = (hex: string) => `SHA256:${Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')}`;

const sftpCall = <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

const MAX_ENTRIES = 20_000;

/** Counts a directory and finds its newest entry, reading in batches so a huge or hostile listing cannot exhaust memory. */
async function scanDir(channel: SFTPWrapper, path: string): Promise<{ entries: number; newest: number; truncated: boolean }> {
  const handle = await sftpCall<Buffer>((cb) => channel.opendir(path, cb));
  let entries = 0, newest = 0;
  try {
    while (entries < MAX_ENTRIES) {
      let batch: { filename: string; attrs: { mtime?: number } }[] | false;
      try { batch = await sftpCall<{ filename: string; attrs: { mtime?: number } }[] | false>((cb) => channel.readdir(handle, cb)); } catch (e) {
        if ((e as { code?: number }).code === utils.sftp.STATUS_CODE.EOF) break; // servers end a listing with an EOF status
        throw e;
      }
      if (!batch) break;
      for (const e of batch) {
        if (e.filename === '.' || e.filename === '..') continue;
        entries++;
        newest = Math.max(newest, Number(e.attrs?.mtime) || 0);
      }
    }
  } finally { channel.close(handle, () => {}); }
  return { entries, newest, truncated: entries >= MAX_ENTRIES };
}

/** A status reply from the server (file missing, permission denied) has a numeric code; anything else is the connection failing. */
const isServerStatus = (e: unknown) => typeof (e as { code?: unknown }).code === 'number';

const sftp: Runner = {
  type: 'sftp', label: 'SFTP', category: 'Network',
  fields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'files.example.com' },
    { key: 'port', label: 'Port', kind: 'number', default: 22, min: 1, max: 65535 },
    { key: 'username', label: 'Username', kind: 'text', required: true },
    { key: 'authMethod', label: 'Authentication', kind: 'select', required: true, default: 'password', options: [{ value: 'password', label: 'Password' }, { value: 'key', label: 'Private key' }] },
    { key: 'password', label: 'Password', kind: 'secret', showIf: { key: 'authMethod', equals: 'password' } },
    { key: 'privateKey', label: 'Private key', kind: 'secret', multiline: true, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', showIf: { key: 'authMethod', equals: 'key' } },
    { key: 'passphrase', label: 'Key passphrase (optional)', kind: 'secret', showIf: { key: 'authMethod', equals: 'key' } },
    { key: 'hostKey', label: 'Pinned host key (optional)', kind: 'text', placeholder: 'SHA256:…', help: 'Fingerprint as printed by ssh-keygen -lf (SHA256:…). Without it any host key is accepted; the current one is shown in the check details.' },
    { key: 'path', label: 'Path to check (optional)', kind: 'text', placeholder: '/backups/latest.tar.gz', help: 'A file or directory that must exist and be readable.' },
    { key: 'minSize', label: 'Minimum file size in bytes (optional)', kind: 'number', min: 0, help: 'Applies to files.' },
    { key: 'maxAgeMin', label: 'Maximum file age in minutes (optional)', kind: 'number', min: 1, help: 'Fails when the file, or for a directory its newest entry, was not modified recently, e.g. for backup drop folders.' },
  ],
  async run(ctx) {
    const c = ctx.config;
    const t0 = process.hrtime.bigint();
    // a pin that is not a valid SHA-256 fingerprint must fail the check, never fall back to "accept any key"
    const pinned = c.hostKey ? normalizeFingerprint(String(c.hostKey)) : '';
    if (c.hostKey && !/^[0-9a-f]{64}$/.test(pinned)) return fail('config', 'The pinned host key is not a valid SHA-256 fingerprint (expected SHA256:… as printed by ssh-keygen -lf)');
    if (c.authMethod === 'key') {
      const parsed = utils.parseKey(String(c.privateKey ?? '').replace(/\r\n/g, '\n'), c.passphrase || undefined);
      if (parsed instanceof Error) return fail('config', `The private key cannot be used: ${parsed.message}`);
    }
    let conn;
    try { conn = await connect({ host: c.host, port: c.port ?? 22, signal: ctx.signal, guard: ctx.guard }); } catch (e) { const ce = toCheckError(e); return fail(ce.kind, ce.message, { details: ce.details }); }
    const client = new Client();
    let seen = '';
    // closing the client makes every pending SFTP request fail, so an abort cannot leave the check hanging
    const onAbort = () => { client.destroy(); conn.close(); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect({
          sock: conn.sock, username: c.username, readyTimeout: ctx.timeoutMs, hostHash: 'sha256',
          ...(c.authMethod === 'key' ? { privateKey: String(c.privateKey ?? '').replace(/\r\n/g, '\n'), passphrase: c.passphrase || undefined } : { password: c.password ?? '' }),
          hostVerifier: (hex: string) => { seen = hex; return !pinned || hex === pinned; },
        });
      });
      client.on('error', () => {}); // after login, ssh2 drops its listeners: a late protocol error must not become an uncaught exception
      const details: Record<string, unknown> = { hostKey: sha256Label(seen) };
      const channel = await sftpCall<SFTPWrapper>((cb) => client.sftp(cb));
      channel.on('error', () => {});
      if (!c.path) return ok(hrMs(t0), { message: 'SFTP login succeeded', details });
      let st: Stats;
      try { st = await sftpCall<Stats>((cb) => channel.stat(c.path, cb)); } catch (e) {
        if (!isServerStatus(e)) throw e;
        const code = (e as { code?: number }).code;
        return fail('content', code === 2 ? `Path not found: ${c.path}` : code === 3 ? `Permission denied: ${c.path}` : `Cannot read ${c.path}: ${(e as Error).message}`, { details, latencyMs: Math.round(hrMs(t0)) });
      }
      const mtime = Number.isFinite(st.mtime) ? st.mtime : undefined;
      Object.assign(details, { path: c.path, size: st.size, modified: mtime === undefined ? null : new Date(mtime * 1000).toISOString(), isDirectory: st.isDirectory() });
      const isDir = st.isDirectory();
      let newest = mtime, listing = '';
      if (isDir) {
        let scan;
        try { scan = await scanDir(channel, c.path); } catch (e) {
          if (!isServerStatus(e)) throw e;
          return fail('content', `Cannot list ${c.path}: ${(e as Error).message}`, { details, latencyMs: Math.round(hrMs(t0)) });
        }
        details.entries = scan.entries;
        newest = scan.newest || undefined;
        listing = ` (${scan.entries}${scan.truncated ? '+' : ''} entries)`;
        if (c.maxAgeMin !== undefined && !scan.entries) return fail('content', `${c.path} is empty, expected a file modified within ${c.maxAgeMin} min`, { details, latencyMs: Math.round(hrMs(t0)) });
      } else if (c.minSize !== undefined) {
        if (!Number.isFinite(st.size)) return fail('protocol', `The server did not report a size for ${c.path}`, { details, latencyMs: Math.round(hrMs(t0)) });
        if (st.size < c.minSize) return fail('content', `${c.path} is ${st.size} bytes, expected at least ${c.minSize}`, { details, latencyMs: Math.round(hrMs(t0)) });
      }
      const ageMin = newest === undefined ? undefined : Math.max(0, Math.floor((Date.now() / 1000 - newest) / 60));
      if (c.maxAgeMin !== undefined) {
        if (ageMin === undefined) return fail('protocol', `The server did not report a modification time for ${c.path}`, { details, latencyMs: Math.round(hrMs(t0)) });
        if (ageMin > c.maxAgeMin) return fail('content', `${isDir ? 'Newest entry in ' : ''}${c.path} was last modified ${ageMin} min ago, expected at most ${c.maxAgeMin}`, { details, latencyMs: Math.round(hrMs(t0)) });
      }
      return ok(hrMs(t0), { message: isDir ? `Directory ${c.path} readable${listing}${ageMin === undefined ? '' : `, newest entry ${ageMin} min old`}` : `${c.path} found (${st.size} bytes${ageMin === undefined ? '' : `, ${ageMin} min old`})`, details });
    } catch (e) {
      const err = e as Error & { level?: string };
      if (seen && pinned && seen !== pinned) return fail('tls', `Host key mismatch: server presented ${sha256Label(seen)}`, { details: { hostKey: sha256Label(seen) } });
      if (err.level === 'client-authentication') return fail('auth', 'Authentication failed (check username and password or key)');
      if (err.level === 'client-timeout' || ctx.signal.aborted) return fail('timeout', 'Timed out talking to the SFTP server', { details: { phase: 'response' } });
      const ce = toCheckError(err);
      return fail(ce.kind === 'internal' ? 'protocol' : ce.kind, ce.message, { details: ce.details });
    } finally { ctx.signal.removeEventListener('abort', onAbort); client.end(); conn.close(); }
  },
};

export const sftpRunners: Runner[] = [sftp];
