export interface BulkLine { line: number; name: string; address: string }

const stripScheme = (a: string) => a.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');

/**
 * One target per line: "name<TAB>address", "name | address", "name; address", "name, address" or just "address".
 * shortcut: the separator is the first one found and only counts if the left part is not itself a URL; a name containing a separator needs a tab or "|".
 */
export function parseBulk(text: string): BulkLine[] {
  const out: BulkLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    const sep = l.search(/[\t|;,]/);
    const left = sep > 0 ? l.slice(0, sep).trim() : '';
    const right = sep > 0 ? l.slice(sep + 1).trim() : '';
    if (left && right && !left.includes('://')) out.push({ line: i + 1, name: left, address: right });
    else out.push({ line: i + 1, name: stripScheme(l), address: l });
  });
  return out;
}
