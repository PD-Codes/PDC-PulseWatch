import net from 'node:net';
import { DEFAULT_DENY } from '../core';
import { config } from './config';
import type { Ctx } from './context';

export interface SsrfSettings { mode: 'allow-private' | 'public-only'; allow: string[]; deny: string[] }

/** An IP address or CIDR range, as the SSRF rules accept it. */
export const isCidr = (e: string) => { const [a, b] = e.split('/'); return net.isIP(a) > 0 && (b === undefined || (/^\d+$/.test(b) && Number(b) <= (net.isIPv6(a) ? 128 : 32))); };

/** Effective rules: the database setting (editable in the UI) overrides the environment defaults. */
export async function applySsrfSettings(ctx: Ctx): Promise<void> {
  const s = await ctx.settings.get<SsrfSettings | null>('ssrf', null);
  const cfg = s ? { mode: s.mode, allow: s.allow, deny: [...DEFAULT_DENY, ...s.deny] } : { mode: config.ssrf.mode, allow: config.ssrf.allow, deny: [...DEFAULT_DENY, ...config.ssrf.deny] };
  if (JSON.stringify(cfg) !== JSON.stringify(ctx.guard.config)) ctx.guard.update(cfg);
}

/** Keeps every process (api and workers) in step with the stored settings. */
export function startGuardSync(ctx: Ctx): () => void {
  const run = () => applySsrfSettings(ctx).catch((e) => ctx.log.warn({ err: e }, 'SSRF settings could not be applied'));
  void run();
  const t = setInterval(run, 30_000);
  t.unref();
  return () => clearInterval(t);
}
