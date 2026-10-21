import { compileRegex, regexInput } from './regex';
/** Minimal JSON path: $.a.b[0]["key with space"].c: enough for assertions without a dependency. */
export function jsonGet(doc: unknown, path: string): unknown {
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  const tokens: (string | number)[] = [];
  const re = /\.([A-Za-z0-9_$-]+)|\[(\d+)\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  if (p && !/^[.[]/.test(p)) p = '.' + p;
  while ((m = re.exec(p))) {
    if (m.index !== last) throw new Error(`Invalid JSON path near "${p.slice(last)}"`);
    last = re.lastIndex;
    tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : (m[3] ?? m[4]).replace(/\\(.)/g, '$1')));
  }
  if (last !== p.length) throw new Error(`Invalid JSON path near "${p.slice(last)}"`);
  let cur: any = doc;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[t as any];
  }
  return cur;
}

export type JsonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'regex' | 'exists';

/** Compare an extracted value with the expected text from the monitor config. */
export function jsonCompare(actual: unknown, op: JsonOp, expected: string): boolean {
  if (op === 'exists') return actual !== undefined && actual !== null;
  if (actual === undefined) return false;
  const a = typeof actual === 'object' && actual !== null ? JSON.stringify(actual) : String(actual);
  switch (op) {
    case 'eq': return a === expected;
    case 'ne': return a !== expected;
    case 'contains': return a.includes(expected);
    case 'regex': return compileRegex(String(expected)).test(regexInput(String(a)));
    default: {
      const x = Number(a), y = Number(expected);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      return op === 'gt' ? x > y : op === 'gte' ? x >= y : op === 'lt' ? x < y : x <= y;
    }
  }
}
