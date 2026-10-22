import type { Selectable } from 'kysely';
import { getRunner, secretFields, type Runner } from '../../core';
import { decrypt, encrypt } from '../crypto';
import { bool, parseJson } from '../db';
import type { MonitorsTable } from '../db/types';

/** Location id used for the server's own raw result in multi-location monitors. 0 is the monitor's effective verdict. */
export const LOCAL_LOCATION_ID = 4294967295;

export interface Monitor {
  id: number; name: string; type: string; groupId: number | null; description: string | null; config: Record<string, any>;
  intervalS: number; timeoutS: number; retries: number; retryIntervalS: number; upThreshold: number; downThreshold: number;
  flapWindow: number; flapThreshold: number; downAfterS: number | null; active: boolean; locations: (number | 'local')[] | null; quorum: number;
  pushToken: string | null; publicBadge: boolean; attempt: number; nextRunAt: Date | null; createdAt: Date;
}

const isEnc = (v: unknown): v is string => typeof v === 'string' && v.startsWith('enc:v1:');

/** Decrypt every secret field of a stored config. */
export function decryptConfig(runner: Runner | undefined, stored: Record<string, any>): Record<string, any> {
  if (!runner) return stored;
  const out = { ...stored };
  for (const f of secretFields(runner)) {
    const v = out[f.key];
    if (f.kind === 'secret' && isEnc(v)) out[f.key] = decrypt(v);
    if (f.kind === 'kv' && v && typeof v === 'object') out[f.key] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isEnc(x) ? decrypt(x) : x]));
  }
  return out;
}

/** Encrypt secret fields before they are written to the database. */
export function encryptConfig(runner: Runner, config: Record<string, any>): Record<string, any> {
  const out = { ...config };
  for (const f of secretFields(runner)) {
    const v = out[f.key];
    if (f.kind === 'secret' && typeof v === 'string' && v) out[f.key] = encrypt(v);
    if (f.kind === 'kv' && v && typeof v === 'object') out[f.key] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && x ? encrypt(x) : x]));
  }
  return out;
}

export function parseMonitor(row: Selectable<MonitorsTable>): Monitor {
  const runner = getRunner(row.type);
  return {
    id: row.id, name: row.name, type: row.type, groupId: row.group_id, description: row.description,
    config: decryptConfig(runner, parseJson(row.config, {})),
    intervalS: row.interval_s, timeoutS: row.timeout_s, retries: row.retries, retryIntervalS: row.retry_interval_s,
    upThreshold: row.up_threshold, downThreshold: row.down_threshold, flapWindow: row.flap_window, flapThreshold: row.flap_threshold, downAfterS: row.down_after_s,
    active: bool(row.active), locations: parseJson(row.locations, null), quorum: row.quorum, pushToken: row.push_token,
    publicBadge: bool(row.public_badge), attempt: row.attempt, nextRunAt: row.next_run_at, createdAt: row.created_at,
  };
}

export const isMultiLocation = (m: Monitor) => !!m.locations && (m.locations.length > 1 || (m.locations.length === 1 && m.locations[0] !== 'local'));
