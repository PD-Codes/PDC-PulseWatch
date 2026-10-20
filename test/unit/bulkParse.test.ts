import { describe, expect, it } from 'vitest';
import { parseBulk } from '../../web/src/lib/bulkParse';

describe('parseBulk', () => {
  it('reads name/address pairs with the common separators', () => {
    const r = parseBulk('Web | https://a.example\nMail;mail.example\nDB,db.example\nTab\ttab.example');
    expect(r.map((x) => [x.name, x.address])).toEqual([['Web', 'https://a.example'], ['Mail', 'mail.example'], ['DB', 'db.example'], ['Tab', 'tab.example']]);
  });
  it('derives the name from a bare address and keeps URLs with commas whole', () => {
    const r = parseBulk('https://x.example/path/\nhttps://y.example/a,b');
    expect(r.map((x) => [x.name, x.address])).toEqual([['x.example/path', 'https://x.example/path/'], ['y.example/a,b', 'https://y.example/a,b']]);
  });
  it('skips blank lines and comments but keeps real line numbers', () => {
    expect(parseBulk('\n# note\nhost.example').map((x) => x.line)).toEqual([3]);
  });
});
