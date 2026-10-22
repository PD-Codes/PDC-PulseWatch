import { httpRequest, type HttpResponse } from '../http';
import { jsonCompare, jsonGet, type JsonOp } from '../jsonpath';
import { compileRegex, regexInput } from '../regex';
import { CheckError, type CheckResult, type FieldDef, type RunContext, type Runner } from '../types';
import { certExpiryError, fail, ok, statusMatcher, toCheckError } from '../util';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => ({ value: m, label: m }));
const JSON_OPS: { value: JsonOp; label: string }[] = [
  { value: 'eq', label: 'equals' }, { value: 'ne', label: 'does not equal' }, { value: 'contains', label: 'contains' },
  { value: 'regex', label: 'matches regex' }, { value: 'gt', label: 'greater than' }, { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' }, { value: 'lte', label: 'less or equal' }, { value: 'exists', label: 'exists' },
];

function httpFields(kind: 'http' | 'keyword' | 'json'): FieldDef[] {
  const f: FieldDef[] = [
    { key: 'url', label: 'URL', kind: 'text', required: true, placeholder: 'https://example.com/health' },
    { key: 'method', label: 'Method', kind: 'select', options: METHODS, default: 'GET' },
    { key: 'expectedStatus', label: 'Expected status codes', kind: 'codes', default: '200-299', help: 'Comma separated codes or ranges, e.g. 200-299,301' },
  ];
  if (kind === 'keyword') f.push(
    { key: 'keyword', label: 'Keyword', kind: 'text', required: true },
    { key: 'caseSensitive', label: 'Case sensitive', kind: 'bool', default: false },
    { key: 'invert', label: 'Fail if keyword is present', kind: 'bool', default: false },
  );
  if (kind === 'json') f.push(
    { key: 'jsonPath', label: 'JSON path', kind: 'text', required: true, placeholder: '$.status' },
    { key: 'jsonOp', label: 'Condition', kind: 'select', options: JSON_OPS, default: 'eq' },
    { key: 'jsonExpected', label: 'Expected value', kind: 'text', placeholder: 'ok' },
  );
  f.push(
    { key: 'headers', label: 'Headers', kind: 'kv', secretValues: true },
    { key: 'body', label: 'Request body', kind: 'textarea' },
    { key: 'authType', label: 'Authentication', kind: 'select', options: [{ value: 'none', label: 'None' }, { value: 'basic', label: 'Basic' }, { value: 'bearer', label: 'Bearer token' }], default: 'none' },
    { key: 'basicUser', label: 'Username', kind: 'text', showIf: { key: 'authType', equals: 'basic' } },
    { key: 'basicPass', label: 'Password', kind: 'secret', showIf: { key: 'authType', equals: 'basic' } },
    { key: 'bearerToken', label: 'Token', kind: 'secret', showIf: { key: 'authType', equals: 'bearer' } },
    { key: 'followRedirects', label: 'Follow redirects', kind: 'bool', default: true },
    { key: 'maxRedirects', label: 'Max redirects', kind: 'number', default: 10, min: 0, max: 50 },
    { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
    { key: 'tlsExpiryDays', label: 'Fail when certificate expires within (days, 0 = off)', kind: 'number', default: 0, min: 0, max: 365 },
  );
  return f;
}

export function authHeaders(c: Record<string, any>): Record<string, string> {
  const h: Record<string, string> = { ...(c.headers ?? {}) };
  if (c.authType === 'basic') h['Authorization'] = 'Basic ' + Buffer.from(`${c.basicUser ?? ''}:${c.basicPass ?? ''}`).toString('base64');
  if (c.authType === 'bearer') h['Authorization'] = `Bearer ${c.bearerToken ?? ''}`;
  return h;
}

/** Body assertions shared by keyword, json and multi-step checks. Returns an error or null. */
export function assertBody(res: HttpResponse, a: { keyword?: string; caseSensitive?: boolean; invert?: boolean; jsonPath?: string; jsonOp?: JsonOp; jsonExpected?: string }): CheckError | null {
  if (a.keyword) {
    const hay = a.caseSensitive ? res.body : res.body.toLowerCase();
    const needle = a.caseSensitive ? a.keyword : a.keyword.toLowerCase();
    const found = hay.includes(needle);
    if (a.invert && found) return new CheckError('content', `Unwanted keyword "${a.keyword}" found in response`);
    if (!a.invert && !found) return new CheckError('content', `Keyword "${a.keyword}" not found in response${res.truncated ? ' (response truncated)' : ''}`);
  }
  if (a.jsonPath) {
    let doc: unknown;
    try { doc = JSON.parse(res.body); } catch { return new CheckError('content', 'Response is not valid JSON'); }
    let actual: unknown;
    try { actual = jsonGet(doc, a.jsonPath); } catch (e) { return new CheckError('config', (e as Error).message); }
    const op = a.jsonOp ?? 'eq';
    let pass = false;
    try { pass = jsonCompare(actual, op, a.jsonExpected ?? ''); } catch (e) { return new CheckError('config', `Invalid expression: ${(e as Error).message}`); }
    if (!pass) return new CheckError('content', `JSON ${a.jsonPath} is ${JSON.stringify(actual) ?? 'missing'}, expected ${op} ${a.jsonExpected ?? ''}`.trim());
  }
  return null;
}

async function runHttp(ctx: RunContext): Promise<CheckResult> {
  const c = ctx.config;
  try {
    const res = await httpRequest({
      url: c.url, method: c.method, headers: authHeaders(c), body: c.body || undefined, signal: ctx.signal, guard: ctx.guard,
      verifyTls: c.verifyTls, followRedirects: c.followRedirects, maxRedirects: c.maxRedirects,
    });
    const details = { statusCode: res.status, finalUrl: res.finalUrl, redirects: res.redirects, timings: res.timings };
    if (!statusMatcher(c.expectedStatus)(res.status)) {
      return fail('http_status', `Unexpected HTTP status ${res.status} ${res.statusText}`.trim(), { latencyMs: Math.round(res.timings.total), details, cert: res.cert });
    }
    const bad = assertBody(res, c);
    if (bad) return fail(bad.kind, bad.message, { latencyMs: Math.round(res.timings.total), details, cert: res.cert });
    const certBad = certExpiryError(res.cert, c.tlsExpiryDays);
    if (certBad) return fail(certBad.kind, certBad.message, { latencyMs: Math.round(res.timings.total), details, cert: res.cert });
    return ok(res.timings.total, { message: `HTTP ${res.status} ${res.statusText}`.trim(), details, cert: res.cert });
  } catch (e) {
    const ce = toCheckError(e);
    return fail(ce.kind, ce.message, { details: ce.details });
  }
}

interface Step {
  name?: string; method?: string; url: string; headers?: Record<string, string>; body?: string; expectStatus?: string;
  extract?: Record<string, string>; keyword?: string; jsonPath?: string; jsonOp?: JsonOp; jsonExpected?: string;
}

const EXAMPLE_STEPS = JSON.stringify([
  { name: 'login', method: 'POST', url: 'https://example.com/api/login', headers: { 'Content-Type': 'application/json' }, body: '{"user":"monitor","password":"{{PASSWORD}}"}', expectStatus: '200', extract: { token: 'json:$.token' } },
  { name: 'profile', url: 'https://example.com/api/me', headers: { Authorization: 'Bearer {{token}}' }, jsonPath: '$.user', jsonOp: 'exists' },
], null, 2);

const interp = (s: string | undefined, vars: Record<string, string>) => (s ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => vars[k] ?? '');

async function runMulti(ctx: RunContext): Promise<CheckResult> {
  const c = ctx.config;
  const steps = c.steps as Step[];
  if (!Array.isArray(steps) || !steps.length) return fail('config', 'No steps configured');
  const vars: Record<string, string> = { ...(c.variables ?? {}) };
  const jar = new Map<string, string>();
  let total = 0;
  for (const [i, s] of steps.entries()) {
    const label = `Step ${i + 1}${s.name ? ` "${s.name}"` : ''}`;
    try {
      const headers = Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, interp(v, vars)]));
      if (jar.size && !headers['Cookie']) headers['Cookie'] = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await httpRequest({
        url: interp(s.url, vars), method: s.method, headers, body: s.body ? interp(s.body, vars) : undefined,
        signal: ctx.signal, guard: ctx.guard, verifyTls: c.verifyTls, followRedirects: c.followRedirects,
      });
      total += res.timings.total;
      for (const sc of res.setCookie) { const [kv] = sc.split(';'); const eq = kv.indexOf('='); if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()); }
      if (!statusMatcher(s.expectStatus)(res.status)) return fail('http_status', `${label}: unexpected HTTP status ${res.status}`, { latencyMs: Math.round(total), details: { step: i + 1 } });
      const bad = assertBody(res, s);
      if (bad) return fail(bad.kind, `${label}: ${bad.message}`, { latencyMs: Math.round(total), details: { step: i + 1 } });
      for (const [name, spec] of Object.entries(s.extract ?? {})) {
        const [kind, ...rest] = spec.split(':');
        const arg = rest.join(':');
        let val: unknown;
        if (kind === 'json') val = jsonGet(JSON.parse(res.body), arg);
        else if (kind === 'header') val = res.headers[arg.toLowerCase()];
        else if (kind === 'regex') { const m = compileRegex(arg).exec(regexInput(res.body)); val = m?.[1] ?? m?.[0]; }
        if (val === undefined || val === null) return fail('content', `${label}: could not extract "${name}" (${spec})`, { latencyMs: Math.round(total), details: { step: i + 1 } });
        vars[name] = String(val);
      }
    } catch (e) {
      const ce = toCheckError(e);
      return fail(ce.kind, `${label}: ${ce.message}`, { latencyMs: Math.round(total), details: { ...ce.details, step: i + 1 } });
    }
  }
  return ok(total, { message: `${steps.length} step(s) passed` });
}

export const httpRunners: Runner[] = [
  { type: 'http', label: 'HTTP(S)', category: 'Web', fields: httpFields('http'), run: runHttp },
  { type: 'keyword', label: 'HTTP(S) keyword', category: 'Web', fields: httpFields('keyword'), run: runHttp },
  { type: 'json', label: 'HTTP(S) JSON query', category: 'Web', fields: httpFields('json'), run: runHttp },
  {
    type: 'multistep', label: 'Multi-step HTTP', category: 'Web',
    fields: [
      { key: 'steps', label: 'Steps (JSON)', kind: 'json', required: true, default: JSON.parse(EXAMPLE_STEPS), help: 'Each step: method, url, headers, body, expectStatus, extract {var: "json:$.path" | "header:name" | "regex:(..)"}, keyword, jsonPath/jsonOp/jsonExpected. Use {{var}} to reuse values.' },
      { key: 'variables', label: 'Variables', kind: 'kv', secretValues: true, help: 'Referenced as {{NAME}} in steps' },
      { key: 'followRedirects', label: 'Follow redirects', kind: 'bool', default: true },
      { key: 'verifyTls', label: 'Verify TLS certificate', kind: 'bool', default: true },
    ],
    run: runMulti,
  },
];
