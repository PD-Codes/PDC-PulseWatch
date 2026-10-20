import { X509Certificate } from 'node:crypto';
import { setExtraCa } from '../core';
import type { Ctx } from './context';

export interface ParsedCa { pem: string; subject: string; issuer: string; fingerprint256: string; validFrom: Date; validTo: Date; isCa: boolean }

/** Splits a PEM bundle into certificates and validates each one. Throws a readable error for anything that is not a certificate. */
export function parsePemBundle(text: string): ParsedCa[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) throw new Error('No PEM certificate found. Expected text starting with -----BEGIN CERTIFICATE-----');
  if (blocks.length > 50) throw new Error('At most 50 certificates can be imported at once');
  return blocks.map((b, i) => {
    try {
      const x = new X509Certificate(b);
      return { pem: x.toString().trim(), subject: x.subject.replace(/\n/g, ', ').slice(0, 500), issuer: x.issuer.replace(/\n/g, ', ').slice(0, 500), fingerprint256: x.fingerprint256, validFrom: new Date(x.validFrom), validTo: new Date(x.validTo), isCa: x.ca };
    } catch { throw new Error(`Certificate ${i + 1} of ${blocks.length} could not be parsed`); }
  });
}

let applied = '';

/** Loads the stored certificates into the trust store of this process (no-op when unchanged). */
export async function applyCaStore(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.selectFrom('ca_certs').select(['pem', 'fingerprint256']).orderBy('id').execute();
  const sig = rows.map((r) => r.fingerprint256).join(',');
  if (sig === applied) return;
  applied = sig;
  setExtraCa(rows.map((r) => r.pem));
  ctx.log.info({ count: rows.length }, 'custom CA certificates applied');
}

/** Keeps api and worker processes in step with the stored certificates. */
export function startCaSync(ctx: Ctx): () => void {
  const run = () => applyCaStore(ctx).catch((e) => ctx.log.warn({ err: e }, 'CA certificates could not be applied'));
  void run();
  const t = setInterval(run, 30_000);
  t.unref();
  return () => clearInterval(t);
}
