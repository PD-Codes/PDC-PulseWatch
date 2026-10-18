import net from 'node:net';
import tls from 'node:tls';
import type { NetGuard } from './guard';
import type { CertInfo } from './types';
import { bindAbort, certFromSocket, toCheckError } from './util';

export interface Conn {
  sock: net.Socket | tls.TLSSocket;
  connectMs: number;
  tlsMs?: number;
  cert?: CertInfo;
  close(): void;
}

export interface ConnectOptions {
  host: string;
  port: number;
  signal: AbortSignal;
  guard: NetGuard;
  /** Wrap the connection in TLS right away (implicit TLS). */
  tls?: { verify: boolean; servername?: string } | false;
}

/** Guarded TCP/TLS connect with phase-aware errors. */
export function connect(o: ConnectOptions): Promise<Conn> {
  return new Promise((resolve, reject) => {
    try { o.guard.assertLiteral(o.host); } catch (e) { return reject(e); }
    const start = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - start) / 1e6;
    let phase = 'dns';
    let connectMs = 0;
    const base = { host: o.host, port: o.port, lookup: o.guard.lookup as any };
    const sock: net.Socket | tls.TLSSocket = o.tls
      ? tls.connect({ ...base, servername: net.isIP(o.tls.servername ?? o.host) ? undefined : (o.tls.servername ?? o.host), rejectUnauthorized: o.tls.verify })
      : net.connect(base);
    const unbind = bindAbort(sock, o.signal);
    sock.once('lookup', () => { phase = 'connect'; });
    sock.once('connect', () => { connectMs = ms(); phase = o.tls ? 'tls' : 'ready'; });
    const onErr = (e: Error) => { unbind(); reject(toCheckError(e, phase)); };
    sock.once('error', onErr);
    const ready = () => {
      sock.off('error', onErr);
      unbind();
      // keep abort handling for the lifetime of the connection
      bindAbort(sock, o.signal);
      sock.on('error', () => {});
      const tlsMs = o.tls ? ms() - connectMs : undefined;
      resolve({ sock, connectMs, tlsMs, cert: o.tls ? certFromSocket(sock as tls.TLSSocket) : undefined, close: () => sock.destroy() });
    };
    if (o.tls) sock.once('secureConnect', ready);
    else sock.once('connect', ready);
  });
}

/** Upgrade an existing plain connection to TLS (STARTTLS, STLS). */
export function upgradeTls(conn: Conn, host: string, verify: boolean, signal: AbortSignal): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const s = tls.connect({ socket: conn.sock as net.Socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: verify });
    const unbind = bindAbort(s, signal);
    s.once('error', (e) => { unbind(); reject(toCheckError(e, 'tls')); });
    s.once('secureConnect', () => {
      s.removeAllListeners('error');
      s.on('error', () => {});
      resolve({ sock: s, connectMs: conn.connectMs, tlsMs: Number(process.hrtime.bigint() - start) / 1e6, cert: certFromSocket(s), close: () => s.destroy() });
    });
  });
}
