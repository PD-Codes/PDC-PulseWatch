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

/** When a client sends the mask back unchanged, keep the stored secret. */
export function restoreSecrets(runner: Runner, incoming: Record<string, any>, stored: Record<string, any>): Record<string, any> {
  const out = { ...incoming };
  for (const f of runner.fields) {
    if (f.kind === 'secret' && out[f.key] === SECRET_MASK) out[f.key] = stored[f.key];
    if (f.kind === 'kv' && f.secretValues && out[f.key]) {
      out[f.key] = Object.fromEntries(Object.entries(out[f.key]).map(([k, v]) => [k, v === SECRET_MASK ? stored[f.key]?.[k] ?? '' : v]));
    }
  }
  return out;
}

export function secretFields(runner: Runner): FieldDef[] {
  return runner.fields.filter((f) => f.kind === 'secret' || (f.kind === 'kv' && f.secretValues));
}
