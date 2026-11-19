/** Longest slice of a response a user-supplied pattern is run against. */
export const REGEX_INPUT_MAX = 256 * 1024;

const NESTED = 'Regular expression nests quantifiers, which can hang the check. Simplify it.';
const BACKREF = 'Regular expressions with backreferences (\\1, \\k<name>) are not supported, because they can hang the check. Rewrite the pattern without them.';
const OVERLAP = 'Regular expression repeats a group whose alternatives can match the same text, which can hang the check. Simplify it.';

/** First token of an alternative: a one-character regex source, or ANY when it cannot be told (group, optional atom, empty branch). */
const ANY = '\0any';
/** Sample alphabet for the overlap test of two first tokens. */
const ALPHABET = [...Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)), 'ä', 'ß', '€', '中', ' ', ' ', '\ud83d'];
const single = new Map<string, RegExp | null>();
const one = (tok: string): RegExp | null => {
  if (!single.has(tok)) { try { single.set(tok, new RegExp(`^(?:${tok})$`)); } catch { single.set(tok, null); } }
  return single.get(tok)!;
};
function overlaps(a: string, b: string): boolean {
  if (a === ANY || b === ANY || a === b) return true;
  const x = one(a), y = one(b);
  if (!x || !y) return true;
  return ALPHABET.some((c) => x.test(c) && y.test(c));
}

interface Frame {
  branches: string[]; // first token per alternative ('' = none yet)
  count: number; // consuming atoms in the current alternative
  lastAtom: { kind: 'char' | 'group' | 'zero'; group?: Summary } | null;
  sum: Summary;
}
/** What a group contains at any depth. */
interface Summary { unbounded: boolean; bounded: boolean; overlap: boolean }

/**
 * Refuses patterns with catastrophic backtracking a check could hang on: a repeated group that contains a quantifier at any depth (`(a+)+`, `((a+))+`,
 * `(?:(a+))+`, `(a?a)+`) or alternatives that can start with the same character (`(a|a)+`, `(\w|\d)+`). Bounded inner quantifiers stay allowed under a
 * bounded repeat, so `(\d{1,3}\.){3}` still works.
 * Backreferences are refused outright: V8's linear fallback engine cannot run them, so it cannot step in either.
 * shortcut: a structural heuristic, not a proof (`(a+)(a+)(a+)b` stays polynomial and passes); the server also runs with V8's backtrack fallback engine.
 */
export function checkRegexSafety(source: string): void {
  const frame = (): Frame => ({ branches: [''], count: 0, lastAtom: null, sum: { unbounded: false, bounded: false, overlap: false } });
  const stack: Frame[] = [frame()];
  const top = () => stack[stack.length - 1]!;
  const atom = (kind: 'char' | 'zero' | 'group', tok: string, group?: Summary) => {
    const f = top();
    f.lastAtom = { kind, group };
    if (kind === 'zero') return;
    f.count++;
    const i = f.branches.length - 1;
    if (f.branches[i] === '') f.branches[i] = kind === 'group' ? ANY : tok;
  };
  const lit = (c: string) => (/[A-Za-z0-9]/.test(c) ? c : `\\${c}`);
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      const rest = source.slice(i);
      const m = /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|[pP]\{[^}]*\}|k<[^>]*>|[1-9]\d*|[\s\S])/.exec(rest);
      const tok = m ? m[0] : '\\';
      i += tok.length;
      if (tok === '\\b' || tok === '\\B') atom('zero', tok);
      // the linear fallback engine cannot run backreferences, so a backtracking pattern with one could block the event loop for seconds
      else if (/^\\(?:[1-9]|k<)/.test(tok)) throw new Error(BACKREF);
      else atom('char', tok);
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j++;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      atom('char', source.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '(') {
      const m = /^\(\?(?:[:=!]|<[=!]|<[A-Za-z_$][\w$]*>|[a-zA-Z-]+:)?/.exec(source.slice(i));
      i += m ? m[0].length : 1;
      stack.push(frame());
      continue;
    }
    if (c === ')') {
      i++;
      if (stack.length === 1) { atom('char', '\\)'); continue; } // let RegExp report the syntax error
      const f = stack.pop()!;
      const firsts = f.branches.map((b) => b || ANY);
      if (firsts.length > 1 && firsts.some((a, x) => firsts.some((b, y) => y > x && overlaps(a, b)))) f.sum.overlap = true;
      const p = top();
      p.sum.unbounded ||= f.sum.unbounded; p.sum.bounded ||= f.sum.bounded; p.sum.overlap ||= f.sum.overlap;
      atom('group', ANY, f.sum);
      continue;
    }
    if (c === '|') { i++; const f = top(); f.branches.push(''); f.count = 0; f.lastAtom = null; continue; }
    if (c === '^' || c === '$') { i++; atom('zero', c); continue; }
    const q = /^(?:[*+?]|\{(\d+)(,(\d*))?\})/.exec(source.slice(i));
    if (q) {
      i += q[0].length;
      if (source[i] === '?') i++; // lazy
      const min = q[0] === '+' ? 1 : q[0] === '*' || q[0] === '?' ? 0 : Number(q[1]);
      const max = q[0] === '?' ? 1 : q[0] === '+' || q[0] === '*' ? Infinity : q[2] === undefined ? Number(q[1]) : q[3] === '' ? Infinity : Number(q[3]);
      const f = top();
      const a = f.lastAtom;
      if (!a) continue; // nothing to repeat: RegExp reports it
      if (a.kind === 'group' && a.group && max > 1) {
        if (a.group.unbounded || (max === Infinity && a.group.bounded)) throw new Error(NESTED);
        if (a.group.overlap) throw new Error(OVERLAP);
      }
      if (max === Infinity) f.sum.unbounded = true; else if (max > 1 || min === 0) f.sum.bounded = true;
      // an optional first atom means the alternative may start with whatever follows
      if (min === 0 && a.kind !== 'zero' && f.count === 1) f.branches[f.branches.length - 1] = ANY;
      f.lastAtom = null;
      continue;
    }
    i++;
    atom('char', c === '.' ? '.' : lit(c));
  }
}

/**
 * Compiles a pattern an editor typed into a monitor. A single catastrophic pattern would block the event loop for every monitor,
 * so patterns that are very long, nest quantifiers or repeat overlapping alternatives are refused (see checkRegexSafety).
 */
export function compileRegex(source: string): RegExp {
  if (source.length > 512) throw new Error('Regular expression is too long (max 512 characters)');
  checkRegexSafety(source);
  return new RegExp(source);
}

export const regexInput = (s: string): string => (s.length > REGEX_INPUT_MAX ? s.slice(0, REGEX_INPUT_MAX) : s);
