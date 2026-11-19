import type { FieldDef, Runner } from './types';

export const SECRET_MASK = '••••••••';

export interface ValidationResult {
  config: Record<string, any>;
  errors: string[];
}

/** Validate and normalize a monitor config against the runner's field list. Unknown keys are dropped. */
export function validateConfig(runner: Runner, input: Record<string, any>): ValidationResult {
  const out: Record<string, any> = {};
  const errors: string[] = [];
  for (const f of runner.fields) {
    if (f.showIf && input[f.showIf.key] !== f.showIf.equals && (out[f.showIf.key] ?? f.default) !== f.showIf.equals) {
      // still keep a value if the user provided one, but do not require it
      if (input[f.key] === undefined) continue;
    }
    let v = input[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required && !(f.showIf && input[f.showIf.key] !== f.showIf.equals)) errors.push(`${f.label} is required`);
      if (f.default !== undefined) out[f.key] = f.default;
      continue;
    }
    switch (f.kind) {
      case 'number': {
        v = Number(v);
        if (!Number.isFinite(v)) { errors.push(`${f.label} must be a number`); continue; }
        if (f.min !== undefined && v < f.min) errors.push(`${f.label} must be >= ${f.min}`);
        if (f.max !== undefined && v > f.max) errors.push(`${f.label} must be <= ${f.max}`);
        break;
      }
      case 'bool': v = v === true || v === 'true' || v === 1; break;
      case 'select':
        if (!f.options?.some((o) => o.value === String(v))) { errors.push(`${f.label} has an invalid value`); continue; }
        v = String(v);
        break;
      case 'kv':
        if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${f.label} must be an object`); continue; }
        v = Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), String(x)]));
        break;
      case 'json':
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { errors.push(`${f.label} must be valid JSON`); continue; } }
        break;
      default:
        v = String(v);
        if (v.length > 20000) { errors.push(`${f.label} is too long`); continue; }
    }
    out[f.key] = v;
  }
  return { config: out, errors };
}

/** Replace secret values with a mask so they never leave the server. */
export function maskSecrets(runner: Runner | undefined, config: Record<string, any>): Record<string, any> {
  if (!runner) return config;
  const out = { ...config };
  for (const f of runner.fields) {
    if (f.kind === 'secret' && out[f.key]) out[f.key] = SECRET_MASK;
    if (f.kind === 'kv' && f.secretValues && out[f.key]) out[f.key] = Object.fromEntries(Object.keys(out[f.key]).map((k) => [k, SECRET_MASK]));
  }
  return out;
}

/** Thrown by restoreSecrets when a masked secret would be sent to a different target. Status 400, shaped as a validation error by the API. */
export class SecretTargetError extends Error {
  readonly statusCode = 400;
  constructor(public errors: string[]) { super(errors.join('; ')); }
}

/** Fields that decide where a request (and with it the secret) goes. Derived from the field keys, so new runners are covered without extra metadata. */
const TARGET_KEY = /^(url|uri|host|hostname|port|server|endpoint|issuer|entryPoint|steps)$|Url$/;
export const targetFields = (runner: Runner): FieldDef[] => runner.fields.filter((f) => TARGET_KEY.test(f.key) && f.kind !== 'secret' && !(f.kind === 'kv' && f.secretValues));

/** Comparable form of a target value: URLs by origin (a new path on the same server keeps the secret), host names case-insensitive, steps by the set of origins they call. */
function targetValue(f: FieldDef, v: unknown, vars: Record<string, string> = {}): string {
  if (v === undefined || v === null || v === '') v = f.default ?? '';
  // {{NAME}} placeholders (multistep variables) are filled in first, so a changed variable that moves a URL counts as a changed target; unknown ones stay as they are
  const fill = (text: string) => text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  if (typeof v === 'string') v = fill(v);
  else if (f.kind === 'json' && v && typeof v === 'object') v = fill(JSON.stringify(v));
  const origin = (s: string) => { try { const u = new URL(s); return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && u.host ? `${u.protocol}//${u.host}`.toLowerCase() : s.trim().toLowerCase(); } catch { return s.trim().toLowerCase(); } };
  if (f.kind === 'json') {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return [...new Set((text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi) ?? []).map(origin))].sort().join(' ');
  }
  if (f.kind === 'number') return String(Number(v));
  return origin(String(v));
}

/**
 * When a client sends the mask back unchanged, keep the stored secret, but only while the target fields (URL, host, port, ...) are unchanged.
 * Otherwise an editor who cannot read a secret could point the monitor at their own server and receive it there.
 */
export function restoreSecrets(runner: Runner, incoming: Record<string, any>, stored: Record<string, any>): Record<string, any> {
  const out = { ...incoming };
  // values of secret key/value fields as they would be used: the stored value where the mask came back
  const storedVars: Record<string, string> = {}, incomingVars: Record<string, string> = {};
  for (const f of runner.fields) {
    if (f.kind !== 'kv' || !f.secretValues) continue;
    const st = stored[f.key] && typeof stored[f.key] === 'object' ? stored[f.key] : {};
    const inc = incoming[f.key] && typeof incoming[f.key] === 'object' ? incoming[f.key] : {};
    Object.assign(storedVars, st);
    for (const [k, v] of Object.entries(inc)) incomingVars[k] = v === SECRET_MASK ? String(st[k] ?? '') : String(v);
  }
  const changed = targetFields(runner).filter((f) => targetValue(f, incoming[f.key], incomingVars) !== targetValue(f, stored[f.key], storedVars));
  const refused: string[] = [];
  const reuse = (f: FieldDef, have: unknown) => {
    if (!changed.length || have === undefined || have === null || have === '') return true;
    refused.push(f.label);
    return false;
  };
  for (const f of runner.fields) {
    if (f.kind === 'secret' && out[f.key] === SECRET_MASK) out[f.key] = reuse(f, stored[f.key]) ? stored[f.key] : undefined;
    if (f.kind === 'kv' && f.secretValues && out[f.key] && typeof out[f.key] === 'object') {
      out[f.key] = Object.fromEntries(Object.entries(out[f.key]).map(([k, v]) => [k, v === SECRET_MASK ? (reuse(f, stored[f.key]?.[k]) ? stored[f.key]?.[k] ?? '' : '') : v]));
    }
  }
  if (refused.length) {
    const labels = [...new Set(refused)].join(', ');
    throw new SecretTargetError([`${changed.map((f) => f.label).join(', ')} changed: enter ${labels} again, a stored secret is only reused for the same target`]);
  }
  return out;
}

export function secretFields(runner: Runner): FieldDef[] {
  return runner.fields.filter((f) => f.kind === 'secret' || (f.kind === 'kv' && f.secretValues));
}
