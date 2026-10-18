import net from 'node:net';
import tls from 'node:tls';
import { CheckError, type CertInfo, type ErrorKind } from './types';

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED', 'HOSTNAME_MISMATCH', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PROTOCOL_ERROR',
  'ERR_TLS_HANDSHAKE_TIMEOUT', 'ECONNRESET_TLS',
]);

/** Map any thrown value to a CheckError so runners can report a precise failure mode. */
export function toCheckError(err: unknown, phase?: string): CheckError {
  if (err instanceof CheckError) return err;
  const e = err as NodeJS.ErrnoException & { name?: string };
  const code = e?.code ?? '';
  const msg = e?.message ?? String(err);
  const d = phase ? { phase, code } : { code };
  if (code === 'PW_BLOCKED') return new CheckError('blocked', msg, d);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'ENODATA' || code === 'ENOTIMP' || code === 'ESERVFAIL' || code === 'EBADNAME')
    return new CheckError('dns', `DNS lookup failed: ${msg}`, d);
  if (code === 'ECONNREFUSED') return new CheckError('refused', `Connection refused: ${msg}`, d);
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ABORT_ERR' || code === 'ECONNABORTED')
    return new CheckError('timeout', `Timed out${phase ? ` during ${phase}` : ''}`, d);
  if (TLS_CODES.has(code) || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || /certificate|self.signed|tls|ssl/i.test(msg))
    return new CheckError('tls', `TLS error: ${msg}`, d);
  if (['ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENETDOWN', 'EADDRNOTAVAIL'].includes(code))
    return new CheckError('network', `Network error: ${msg}`, d);
  return new CheckError('internal', msg, d);
}

/** Parse "200-299,301,404" into a predicate. */
export function statusMatcher(spec: string | undefined): (code: number) => boolean {
  const parts = (spec || '200-299').split(',').map((s) => s.trim()).filter(Boolean);
  const ranges = parts.map((p) => {
    const [a, b] = p.split('-').map((n) => parseInt(n, 10));
    return [a, Number.isNaN(b as number) || b === undefined ? a : b] as [number, number];
  });
  return (code) => ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

/** Combine the monitor timeout with the caller's abort signal. */
export function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

export function hrMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Make a socket fail fast on abort. */
export function bindAbort(sock: net.Socket | { destroy(err?: Error): unknown }, signal: AbortSignal): () => void {
  const onAbort = () => sock.destroy(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** Line/chunk reader on top of a socket; resolves with the first data that satisfies `done`. */
export function readUntil(sock: net.Socket, done: (buf: string) => boolean, maxBytes = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      if (done(buf)) cleanup(), resolve(buf);
      else if (buf.length > maxBytes) cleanup(), reject(new CheckError('protocol', 'Response too large'));
    };
    const onEnd = () => { cleanup(); done(buf) ? resolve(buf) : reject(new CheckError('protocol', 'Connection closed by peer')); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr); sock.off('close', onEnd); };
    sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onErr); sock.on('close', onEnd);
  });
}

export function certFromSocket(sock: tls.TLSSocket): CertInfo | undefined {
  const leaf = sock.getPeerCertificate(true);
  if (!leaf || !leaf.subject) return undefined;
  const chain: CertInfo['chain'] = [];
  const seen = new Set<string>();
  let cur: tls.DetailedPeerCertificate | undefined = leaf;
  while (cur && cur.fingerprint256 && !seen.has(cur.fingerprint256)) {
    seen.add(cur.fingerprint256);
    chain.push({ subject: dn(cur.subject), issuer: dn(cur.issuer), validTo: new Date(cur.valid_to).toISOString() });
    cur = cur.issuerCertificate as tls.DetailedPeerCertificate | undefined;
  }
  const validTo = new Date(leaf.valid_to);
  return {
    subject: dn(leaf.subject),
    issuer: dn(leaf.issuer),
    validFrom: new Date(leaf.valid_from).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
    fingerprint256: leaf.fingerprint256,
    serial: leaf.serialNumber,
    altNames: (leaf.subjectaltname ?? '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean),
    chain,
    authorized: sock.authorized,
    authError: sock.authorizationError ? String(sock.authorizationError) : undefined,
  };
}

function dn(o: Record<string, any> | undefined): string {
  if (!o) return '';
  return o.CN ? String(o.CN) : Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ');
}

/** Standard certificate-expiry verdict shared by HTTP/TLS/SMTP runners. */
export function certExpiryError(cert: CertInfo | undefined, warnDays: number): CheckError | null {
  if (!cert || !warnDays) return null;
  if (cert.daysLeft < 0) return new CheckError('tls', `Certificate expired ${-cert.daysLeft} day(s) ago`, { daysLeft: cert.daysLeft });
  if (cert.daysLeft < warnDays) return new CheckError('tls_expiry', `Certificate expires in ${cert.daysLeft} day(s)`, { daysLeft: cert.daysLeft });
  return null;
}

export const ok = (latencyMs: number, extra: Partial<import('./types').CheckResult> = {}) => ({ ok: true, latencyMs: Math.round(latencyMs), ...extra });
export const fail = (kind: ErrorKind, message: string, extra: Partial<import('./types').CheckResult> = {}) => ({ ok: false, errorKind: kind, message, ...extra });
