// Optional tracing: exports one span per monitor check as OTLP/HTTP JSON. No SDK dependency; off unless PW_OTEL_EXPORTER_OTLP_ENDPOINT is set.
// shortcut: spans are flat (no parent/child) and dropped when the collector is unreachable, upgrade to the OpenTelemetry SDK for context propagation.
import crypto from 'node:crypto';
import { config } from './config';
import { VERSION } from './version';

type Attr = string | number | boolean;
export interface Span { name: string; start: number; end: number; attrs: Record<string, Attr>; error?: string }

const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const val = (v: Attr) => (typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v });

/** Builds the OTLP/JSON request body for a batch of spans (exported for tests). */
export function otlpPayload(spans: Span[], service = config.brand.name.toLowerCase()) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'service.version', value: { stringValue: VERSION } }] },
      scopeSpans: [{
        scope: { name: 'pulsewatch' },
        spans: spans.map((s) => ({
          traceId: hex(16), spanId: hex(8), name: s.name, kind: 1,
          startTimeUnixNano: String(BigInt(Math.round(s.start)) * 1_000_000n), endTimeUnixNano: String(BigInt(Math.round(s.end)) * 1_000_000n),
          attributes: Object.entries(s.attrs).map(([key, v]) => ({ key, value: val(v) })),
          status: s.error ? { code: 2, message: s.error.slice(0, 200) } : { code: 1 },
        })),
      }],
    }],
  };
}

const buffer: Span[] = [];
let timer: NodeJS.Timeout | undefined;

export const tracingEnabled = () => !!config.otlpEndpoint;

export function recordSpan(s: Span): void {
  if (!config.otlpEndpoint) return;
  if (buffer.length < 1000) buffer.push(s);
  timer ??= setInterval(() => void flushSpans(), 5000).unref();
}

export async function flushSpans(): Promise<void> {
  if (!config.otlpEndpoint || !buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await fetch(`${config.otlpEndpoint.replace(/\/$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlpPayload(batch)), signal: AbortSignal.timeout(5000) });
  } catch { /* tracing must never affect monitoring */ }
}

export function stopTracing(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  return flushSpans();
}
