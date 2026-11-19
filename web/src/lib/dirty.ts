import { useRef } from 'react';

/**
 * True while `value` differs from what it was when it first became non-null (the moment a form opened).
 * Pass null while the form is closed; the snapshot is dropped then, so the next opening starts clean.
 * Compared as JSON, which is plenty for form state (strings, numbers, flat lists).
 */
export function useDirty(value: unknown): boolean {
  const base = useRef<string | null>(null);
  const cur = value == null ? null : JSON.stringify(value);
  if (cur === null) base.current = null;
  else if (base.current === null) base.current = cur;
  return cur !== null && base.current !== cur;
}
