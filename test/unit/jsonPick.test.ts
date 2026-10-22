import { describe, expect, it } from 'vitest';
import { jsonCompare, jsonGet } from '../../src/core/jsonpath';
import { child, pickFor, suggestions } from '../../web/src/lib/jsonPick';

const doc = { status: 'ok', 'odd key': { 'a"b': [1, { 'x.y': true }] }, checks: [{ name: 'db', healthy: true }], 'with-dash': 3 };

describe('JSON picker paths', () => {
  it('builds paths the monitor can read back, for plain and awkward keys', () => {
    const paths = [child('$', 'status'), child(child('$', 'odd key'), 'a"b'), child(child(child(child('$', 'odd key'), 'a"b'), 1), 'x.y'), child(child(child('$', 'checks'), 0), 'healthy'), child('$', 'with-dash')];
    expect(paths.map((p) => jsonGet(doc, p))).toEqual(['ok', [1, { 'x.y': true }], true, true, 3]);
  });

  it('proposes a condition that holds for the response it was taken from', () => {
    for (const p of [pickFor('$.status', 'ok'), pickFor('$.with-dash', 3), pickFor('$.checks', doc.checks)]) expect(jsonCompare(jsonGet(doc, p.jsonPath), p.jsonOp, p.jsonExpected)).toBe(true);
  });

  it('suggests status-like fields, also nested, and not more than asked for', () => {
    expect(suggestions(doc).map((s) => s.jsonPath)).toEqual(['$.status', '$.checks[0].healthy']);
    expect(suggestions({ a: { b: { c: { d: { status: 'deep' } } } } })).toEqual([]);
    expect(suggestions({ status: 1, state: 2, health: 3 }, 2)).toHaveLength(2);
    expect(suggestions('text')).toEqual([]);
  });
});
