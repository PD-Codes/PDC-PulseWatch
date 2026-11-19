import { useEffect, type RefObject } from 'react';
import { ApiError } from './api';

/** Field key -> extra words that identify the field in a server message ("interval" for the field `intervalS`). The key itself always matches. */
export type FieldAliases = Record<string, (string | RegExp)[]>;
export interface MappedErrors { fieldErrors: Record<string, string>; rest: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu');

/** Messages of a failed request: the server's `errors` array when it has one, else the single message. */
export function serverErrors(e: unknown): string[] {
  if (e instanceof ApiError && Array.isArray(e.body?.errors) && e.body.errors.length) return e.body.errors.map(String);
  return [e instanceof Error ? e.message : String(e)];
}

/**
 * Assign server validation messages to form fields. A message belongs to a field when it starts with "Field: text"
 * (or the Ajv form "body/field must ..."), or when it names the field (or one of its aliases) as a whole word.
 * The first matching field in `fields` wins. Messages that match no field come back in `rest`, in order.
 * Several messages for one field are joined with "; ".
 */
export function mapServerErrors(errors: string[] | null | undefined, fields: FieldAliases | string[]): MappedErrors {
  const spec: FieldAliases = Array.isArray(fields) ? Object.fromEntries(fields.map((f) => [f, []])) : fields;
  const keys = Object.keys(spec);
  const hit = (field: string, text: string) => [field, ...spec[field]!].some((a) => (a instanceof RegExp ? a.test(text) : wordRe(a).test(text)));
  const out: MappedErrors = { fieldErrors: {}, rest: [] };
  const put = (f: string, text: string) => { out.fieldErrors[f] = out.fieldErrors[f] ? `${out.fieldErrors[f]}; ${text}` : text; };
  for (const raw of errors ?? []) {
    const msg = String(raw).trim();
    if (!msg) continue;
    // Ajv: "body/name must be string", "/tags/0/value must ..."
    const ajv = /^(?:body|querystring|params)?\/?([\w.[\]/-]+) (must|should) (.+)$/.exec(msg);
    if (ajv) {
      const path = ajv[1]!.replace(/^\//, '');
      const f = keys.find((k) => k === path || k === path.split(/[./[]/)[0]);
      if (f) { put(f, msg.slice(msg.indexOf(' ') + 1)); continue; }
    }
    const colon = msg.indexOf(': ');
    if (colon > 0 && colon < 40) {
      const head = msg.slice(0, colon), body = msg.slice(colon + 2);
      const f = keys.find((k) => [k, ...spec[k]!].some((a) => (a instanceof RegExp ? a.test(head) : a.toLowerCase() === head.toLowerCase())));
      if (f) { put(f, body); continue; }
    }
    const f = keys.find((k) => hit(k, msg));
    if (f) put(f, msg); else out.rest.push(msg);
  }
  return out;
}

/** mapServerErrors straight from a caught error. */
export const mapApiError = (e: unknown, fields: FieldAliases | string[]): MappedErrors => mapServerErrors(serverErrors(e), fields);

/** Move focus to the first invalid field (inside `root`, by default inside the open dialog, else the page) and scroll it into view. */
export function focusFirstError(root?: ParentNode | null): boolean {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  const scope = root ?? dialogs[dialogs.length - 1] ?? document;
  const el = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
  return true;
}

/** Focus the first invalid field whenever `errors` changes to something non-empty (the fields must render aria-invalid by then). */
export function useFocusFirstError(errors: Record<string, unknown> | string[] | null | undefined, root?: RefObject<HTMLElement | null>) {
  const has = errors ? Object.keys(errors).length > 0 : false;
  useEffect(() => { if (has) focusFirstError(root?.current); }, [errors, has, root]);
}
