import tls from 'node:tls';

let extra: string[] = [];
let merged: string[] | undefined;

/** Replaces the imported CA certificates (PEM). Applies to every TLS connection opened afterwards. */
export function setExtraCa(pems: string[]): void {
  extra = [...pems];
  merged = undefined;
}

export const extraCaCount = () => extra.length;

/**
 * TLS options that carry the trust store. Node's `ca` option replaces the default roots, so the defaults (bundled roots plus
 * NODE_EXTRA_CA_CERTS) are added back. Returns an empty object when nothing was imported, which keeps Node's own handling.
 * shortcut: the CA list is parsed on every connection (about a millisecond), upgrade to a cached SecureContext when checks reach thousands per second.
 */
export function trustOptions(): { ca?: string[] } {
  if (!extra.length) return {};
  merged ??= [...(tls.getCACertificates?.('default') ?? tls.rootCertificates), ...extra];
  return { ca: merged };
}
