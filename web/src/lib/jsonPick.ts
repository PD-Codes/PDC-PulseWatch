import type { JsonOp } from '../../../src/core/jsonpath';

export interface Pick { jsonPath: string; jsonOp: JsonOp; jsonExpected: string }
export const MAX_ITEMS = 20;

/** Same syntax the monitor understands (see core/jsonpath): dotted names where possible, brackets otherwise. */
export const child = (parent: string, key: string | number) => typeof key === 'number' ? `${parent}[${key}]` : /^[A-Za-z0-9_$-]+$/.test(key) ? `${parent}.${key}` : `${parent}["${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
export const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === 'object' && v !== null;
export const entries = (v: Record<string, unknown> | unknown[]): [string | number, unknown][] => (Array.isArray(v) ? v.map((x, i) => [i, x] as [number, unknown]) : Object.entries(v));

/** What clicking a value should assert: scalars must equal what they are now, containers just have to exist. */
export function pickFor(path: string, value: unknown): Pick {
  if (isContainer(value)) return { jsonPath: path, jsonOp: 'exists', jsonExpected: '' };
  return { jsonPath: path, jsonOp: 'eq', jsonExpected: String(value) };
}

const STATUSY = /^(status|state|health|healthy|ok|up|alive|ready|result|success|online)$/i;
/** Fields that usually say whether the service is fine, found within the first levels. */
export function suggestions(doc: unknown, limit = 6): Pick[] {
  const out: Pick[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (!isContainer(v) || depth > 3 || out.length >= limit) return;
    for (const [k, x] of entries(v).slice(0, MAX_ITEMS)) {
      const p = child(path, k);
      if (!isContainer(x) && typeof k === 'string' && STATUSY.test(k)) out.push(pickFor(p, x));
      else walk(x, p, depth + 1);
      if (out.length >= limit) return;
    }
  };
  walk(doc, '$', 0);
  return out;
}
