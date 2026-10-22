import net from 'node:net';
import tls from 'node:tls';
import type { NetGuard } from './guard';
import { trustOptions } from './trust';
import type { CertInfo, CheckResult, Runner } from './types';
import { certFromSocket } from './util';

/** Where a TLS check connected to. */
export interface TlsTarget { host: string; port: number; servername?: string }

/** Structured certificate facts stored in result.details.tls. */
export interface TlsFacts {
  host?: string; port?: number; servername?: string; code?: string;
  subject: string; issuer: string; validFrom: string; validTo: string; daysLeft: number;
  altNames: string[]; fingerprint256: string; nameMatches?: boolean; selfSigned: boolean;
}

const DAY = 86_400_000;
const VERIFY_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'HOSTNAME_MISMATCH', 'CERT_REVOKED',
]);
const REASONS: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in the chain, import its CA under Settings > Certificates',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the server did not send the intermediate certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the issuing CA is unknown, import it under Settings > Certificates',
  UNABLE_TO_GET_ISSUER_CERT: 'the issuing CA is unknown, import it under Settings > Certificates',
  CERT_UNTRUSTED: 'untrusted certificate', CERT_REVOKED: 'certificate was revoked',
};

const cn = (s: string) => (s.includes('=') ? s : `CN=${s}`);
const day = (iso: string) => iso.slice(0, 10);
const plural = (n: number, lang: 'en' | 'de' = 'en') => (lang === 'de' ? `${n} ${n === 1 ? 'Tag' : 'Tagen'}` : `${n} day${n === 1 ? '' : 's'}`);

/** Host/URL of a monitor config without credentials, paths' query strings or fragments. */
export function describeTarget(c: Record<string, any>): string | undefined {
  if (typeof c.url === 'string' && c.url) {
    try { const u = new URL(c.url); return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return undefined; }
  }
  const host = c.host ?? c.domain ?? c.hostname ?? c.server;
  if (typeof host !== 'string' || !host) return undefined;
  return c.port ? `${host}:${c.port}` : host;
}

/** Best guess of the TLS endpoint of a monitor from its config. */
export function targetFromConfig(c: Record<string, any>): TlsTarget | undefined {
  if (typeof c.url === 'string' && c.url) {
    try {
      const u = new URL(c.url);
      return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80) };
    } catch { return undefined; }
  }
  if (typeof c.host === 'string' && c.host) return { host: c.host, port: Number(c.port) || 443, servername: c.servername || undefined };
  return undefined;
}

export function certFacts(cert: CertInfo, t?: TlsTarget, code?: string, nameMatches?: boolean): TlsFacts {
  const validTo = new Date(cert.validTo).getTime();
  return {
    host: t?.host, port: t?.port, servername: t?.servername, code, subject: cert.subject, issuer: cert.issuer, validFrom: cert.validFrom, validTo: cert.validTo,
    daysLeft: Math.floor((validTo - Date.now()) / DAY), altNames: cert.altNames, fingerprint256: cert.fingerprint256, nameMatches, selfSigned: cert.subject === cert.issuer,
  };
}

/**
 * One readable sentence about a certificate problem, always naming the host, subject, issuer and Node error code.
 * shortcut: `lang: 'de'` is only used for expiry notices, so the trust reasons (REASONS) stay English; translate them when a German check result is needed.
 */
export function tlsMessage(f: TlsFacts, opts: { expiring?: boolean; lang?: 'en' | 'de' } = {}): string {
  const de = opts.lang === 'de';
  const now = Date.now();
  const where = f.host ? `${de ? 'Host' : 'host'} ${f.host}${f.port ? `:${f.port}` : ''}${f.servername && f.servername !== f.host ? `, SNI ${f.servername}` : ''}` : undefined;
  const tail = [`${cn(f.subject)}`, `${de ? 'Aussteller' : 'issuer'} ${cn(f.issuer)}`, where].filter(Boolean).join(', ') + (f.code ? ` (${f.code})` : '');
  const expired = new Date(f.validTo).getTime() < now;
  const mismatch = f.nameMatches === false || f.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || f.code === 'HOSTNAME_MISMATCH';
  const isExpired = expired || f.code === 'CERT_HAS_EXPIRED';
  const alt = f.altNames.length ? ` (${de ? 'gültig für' : 'valid for'} ${f.altNames.slice(0, 5).join(', ')}${f.altNames.length > 5 ? ', ...' : ''})` : '';
  const wrong = mismatch ? (de ? `passt nicht zu ${f.servername || f.host || 'dem Host'}${alt}` : `does not match ${f.servername || f.host || 'the host'}${alt}`) : '';
  let head: string;
  if (isExpired) {
    const ago = Math.max(1, Math.ceil((now - new Date(f.validTo).getTime()) / DAY));
    head = de ? `TLS-Zertifikat ist am ${day(f.validTo)} abgelaufen (vor ${plural(ago, 'de')})${wrong ? ` und ${wrong}` : ''}` : `TLS certificate expired on ${day(f.validTo)} (${plural(ago)} ago)${wrong ? ` and ${wrong}` : ''}`; // a certificate can have both problems, name both
  } else if (mismatch) {
    head = `TLS${de ? '-Zertifikat' : ' certificate'} ${wrong}`;
  } else if (new Date(f.validFrom).getTime() > now || f.code === 'CERT_NOT_YET_VALID') {
    head = de ? `TLS-Zertifikat ist erst ab ${day(f.validFrom)} gültig` : `TLS certificate is not valid before ${day(f.validFrom)}`;
  } else if (f.code && REASONS[f.code]) {
    head = `TLS certificate not trusted (${REASONS[f.code]}), valid until ${day(f.validTo)}`;
  } else if (opts.expiring) {
    head = de ? `TLS-Zertifikat läuft am ${day(f.validTo)} ab (${f.daysLeft < 1 ? 'weniger als ein Tag übrig' : `in ${plural(f.daysLeft, 'de')}`})` : `TLS certificate expires on ${day(f.validTo)} (${f.daysLeft < 1 ? 'less than a day left' : `in ${plural(f.daysLeft)}`})`;
  } else {
    head = de ? `TLS-Zertifikat hat ein Problem, gültig bis ${day(f.validTo)}` : `TLS certificate problem, valid until ${day(f.validTo)}`;
  }
  return `${head}: ${tail}`.slice(0, 480);
}

/** Message for certificate expiry notices (event log, notification, digest). */
export function certNotice(cert: CertInfo, config: Record<string, any>, lang?: 'en' | 'de'): string {
  return tlsMessage(certFacts(cert, targetFromConfig(config)), { expiring: true, lang });
}

/**
 * Verification failures abort the handshake before the certificate can be read, so ask the server once more without
 * verification. Best effort: short timeout, never throws, same SSRF guard as the check itself.
 */
export function probeCertificate(t: TlsTarget, guard: NetGuard, timeoutMs = 3000): Promise<{ cert: CertInfo; nameMatches: boolean } | undefined> {
  return new Promise((resolve) => {
    let sock: tls.TLSSocket | undefined;
    const done = (v?: { cert: CertInfo; nameMatches: boolean }) => { clearTimeout(timer); sock?.destroy(); resolve(v); };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    try {
      guard.assertLiteral(t.host);
      const sni = t.servername || t.host;
      sock = tls.connect({ host: t.host, port: t.port, servername: net.isIP(sni) ? undefined : sni, rejectUnauthorized: false, lookup: guard.lookup as any, ...trustOptions() });
      sock.once('secureConnect', () => {
        try {
          const cert = certFromSocket(sock!);
          done(cert ? { cert, nameMatches: !tls.checkServerIdentity(sni, sock!.getPeerCertificate()) } : undefined);
        } catch { done(undefined); }
      });
      sock.once('error', () => done(undefined));
    } catch { done(undefined); }
  });
}

/** Adds certificate details to TLS failures of any runner (thrown TLS errors and expiry verdicts alike). */
export function withTlsDetail(r: Runner): Runner {
  return { ...r, async run(ctx) { return enrich(await r.run(ctx), ctx.config, ctx.guard); } };
}

export async function enrich(res: CheckResult, config: Record<string, any>, guard: NetGuard): Promise<CheckResult> {
  if (res.ok || res.details?.tls || res.details?.hostKey) return res; // an SSH host key problem is not a certificate problem
  const d = res.details ?? {};
  const target: TlsTarget | undefined = typeof d.host === 'string' && d.port ? { host: d.host, port: Number(d.port), servername: d.servername as string | undefined } : targetFromConfig(config);
  if (res.cert && (res.errorKind === 'tls_expiry' || (res.errorKind === 'tls' && /^Certificate expired/.test(res.message ?? '')))) {
    const facts = certFacts(res.cert, target);
    return { ...res, message: tlsMessage(facts, { expiring: true }), details: { ...d, tls: facts } };
  }
  if (res.errorKind !== 'tls' || res.cert) return res;
  const code = typeof d.code === 'string' ? d.code : undefined;
  const plain = (res.message ?? '').replace(/^TLS error:\s*/, '');
  const probed = target && code && VERIFY_CODES.has(code) ? await probeCertificate(target, guard) : undefined;
  if (probed) {
    const facts = certFacts(probed.cert, target, code, probed.nameMatches);
    return { ...res, message: tlsMessage(facts), details: { ...d, tls: facts } };
  }
  const where = target ? `host ${target.host}:${target.port}` : undefined;
  const extra = [where, code].filter(Boolean).join(', ');
  return { ...res, message: `TLS error: ${plain}${extra ? ` (${extra})` : ''}`.slice(0, 480), details: { ...d, tls: { host: target?.host, port: target?.port, code } } };
}
