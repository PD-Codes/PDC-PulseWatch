/** Longest slice of a response a user-supplied pattern is run against. */
export const REGEX_INPUT_MAX = 256 * 1024;

/**
 * Compiles a pattern an editor typed into a monitor. A single catastrophic pattern would block the event loop for every monitor,
 * so patterns that are very long or nest quantifiers inside a quantified group (the classic `(a+)+`) are refused.
 * shortcut: a heuristic, not a proof (alternations like `(a|a)+` slip through); switch to RE2 when untrusted editors are in play.
 */
export function compileRegex(source: string): RegExp {
  if (source.length > 512) throw new Error('Regular expression is too long (max 512 characters)');
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(source)) throw new Error('Regular expression nests quantifiers, which can hang the check. Simplify it.');
  return new RegExp(source);
}

export const regexInput = (s: string): string => (s.length > REGEX_INPUT_MAX ? s.slice(0, REGEX_INPUT_MAX) : s);
