import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import type { NetGuard } from './guard';
import { CheckError, type CertInfo } from './types';
import { certFromSocket, toCheckError } from './util';

export interface HttpOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  guard: NetGuard;
  verifyTls?: boolean;
  followRedirects?: boolean;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  setCookie: string[];
  body: string;
  truncated: boolean;
  finalUrl: string;
  redirects: number;
  timings: { dns?: number; connect?: number; tls?: number; ttfb: number; total: number };
  cert?: CertInfo;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function httpRequest(o: HttpOptions): Promise<HttpResponse> {
  let url = new URL(o.url);
  let method = (o.method ?? 'GET').toUpperCase();
  let body = o.body;
  let headers = { ...(o.headers ?? {}) };
  const t0 = process.hrtime.bigint();
  let redirects = 0;
  const max = o.followRedirects === false ? 0 : (o.maxRedirects ?? 10);
  for (;;) {
    const res = await hop(url, method, headers, body, o, t0);
    const loc = res.headers['location'];
    if (REDIRECT.has(res.status) && typeof loc === 'string' && o.followRedirects !== false) {
      if (redirects >= max) throw new CheckError('redirect', `Too many redirects (>${max})`, { redirects });
      const next = new URL(loc, url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new CheckError('redirect', `Redirect to unsupported protocol ${next.protocol}`);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())));
      }
      url = next;
      redirects++;
      continue;
    }
    res.redirects = redirects;
    return res;
  }
}

function hop(url: URL, method: string, headers: Record<string, string>, body: string | undefined, o: HttpOptions, t0: bigint): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new CheckError('config', `Unsupported protocol ${url.protocol}`));
    try { o.guard.assertLiteral(url.hostname.replace(/^\[|\]$/g, '')); } catch (e) { return reject(e); }
    const isTls = url.protocol === 'https:';
    let phase = 'dns';
    const timings: HttpResponse['timings'] = { ttfb: 0, total: 0 };
    const start = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - start) / 1e6;
    let cert: CertInfo | undefined;
    const h: Record<string, string> = { 'user-agent': 'PulseWatch/1', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    if (body !== undefined && !h['content-length']) h['content-length'] = String(Buffer.byteLength(body));
    const lib = isTls ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (isTls ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: h,
        agent: false,
        lookup: o.guard.lookup as any,
        ...(isTls ? { rejectUnauthorized: o.verifyTls !== false, servername: /^[\d.:]+$/.test(url.hostname) ? undefined : url.hostname } : {}),
      },
      (res) => {
        phase = 'body';
        timings.ttfb = ms();
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const cap = o.maxBodyBytes ?? 1_048_576;
        let stream: Readable = res;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        if (method !== 'HEAD') {
          if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          if (stream !== res) stream.on('error', (e) => reject(new CheckError('protocol', `Could not decode ${enc} body: ${e.message}`)));
        }
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          chunks.push(c);
          if (size >= cap) { truncated = true; req.destroy(); finish(); }
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          timings.total = ms();
          const sc = res.headers['set-cookie'] ?? [];
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: res.headers as any,
            setCookie: sc,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            finalUrl: url.toString(),
            redirects: 0,
            timings,
            cert,
          });
        };
        stream.on('end', finish);
        stream.on('close', finish);
        res.on('error', (e) => { if (!done) reject(toCheckError(e, phase)); });
      },
    );
    req.on('socket', (s) => {
      s.on('lookup', () => { timings.dns = ms(); phase = 'connect'; });
      s.on('connect', () => { timings.connect = ms(); phase = isTls ? 'tls' : 'request'; });
      s.on('secureConnect', () => { timings.tls = ms(); phase = 'request'; cert = certFromSocket(s as any); });
    });
    req.on('error', (e) => reject(toCheckError(e, phase)));
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => o.signal.removeEventListener('abort', onAbort));
    void t0;
    if (body !== undefined) req.write(body);
    req.end();
  });
}
