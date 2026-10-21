import type { NetGuard } from './guard';

/** Why a check failed. Kept coarse on purpose so the event log can tell failure modes apart. */
export type ErrorKind =
  | 'dns' // name could not be resolved
  | 'timeout' // no answer in time (details.phase tells where)
  | 'refused' // connection actively refused
  | 'network' // unreachable / reset / aborted by peer
  | 'tls' // handshake or certificate validation failed
  | 'tls_expiry' // certificate valid but expires too soon
  | 'http_status' // unexpected HTTP status code
  | 'content' // body/keyword/JSON assertion failed
  | 'redirect' // too many or invalid redirects
  | 'protocol' // peer answered but not as the protocol expects
  | 'auth' // credentials rejected
  | 'blocked' // SSRF guard refused the target
  | 'config' // monitor is misconfigured
  | 'missed' // push monitor: expected heartbeat did not arrive
  | 'reported' // push monitor: the job itself reported a failure
  | 'internal';

export interface CertInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint256: string;
  serial: string;
  altNames: string[];
  chain: { subject: string; issuer: string; validTo: string }[];
  authorized?: boolean;
  authError?: string;
}

export interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  errorKind?: ErrorKind;
  message?: string;
  details?: Record<string, unknown>;
  cert?: CertInfo;
}

export type FieldKind = 'text' | 'number' | 'bool' | 'select' | 'textarea' | 'secret' | 'kv' | 'json' | 'codes';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
  help?: string;
  /** Only show/validate this field when another field has the given value. */
  showIf?: { key: string; equals: unknown };
  /** For kind "secret": render a multi-line box (private keys) instead of a single-line password input. */
  multiline?: boolean;
  /** For kind "kv": mask all values like secrets. */
  secretValues?: boolean;
}

export interface RunContext<C = Record<string, any>> {
  config: C;
  timeoutMs: number;
  signal: AbortSignal;
  guard: NetGuard;
  monitor: { id: number; name: string };
}

export interface Runner {
  type: string;
  label: string;
  category: string;
  fields: FieldDef[];
  run(ctx: RunContext): Promise<CheckResult>;
}

export class CheckError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
