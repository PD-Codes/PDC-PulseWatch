import { describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../../web/src/components/nav';
import { mapServerErrors } from '../../web/src/lib/formErrors';

describe('mapServerErrors', () => {
  const fields = { name: [], intervalS: ['interval'], url: ['URL'] };
  it('assigns messages that name a field and returns the rest', () => {
    const r = mapServerErrors(['Name is required (max 255 characters)', 'Check interval must be an integer between 20 and 86400', 'Quorum cannot exceed the number of locations'], fields);
    expect(r.fieldErrors.name).toContain('Name is required');
    expect(r.fieldErrors.intervalS).toContain('between 20');
    expect(r.rest).toEqual(['Quorum cannot exceed the number of locations']);
  });
  it('strips a "Field: text" prefix and understands Ajv paths', () => {
    const r = mapServerErrors(['URL: must be http(s)', 'body/name must be string'], fields);
    expect(r.fieldErrors.url).toBe('must be http(s)');
    expect(r.fieldErrors.name).toBe('must be string');
  });
  it('joins several messages of one field and matches whole words only', () => {
    const r = mapServerErrors(['Name is too long', 'Name already exists', 'Filename is odd'], fields);
    expect(r.fieldErrors.name).toBe('Name is too long; Name already exists');
    expect(r.rest).toEqual(['Filename is odd']);
  });
});

describe('visibleNav', () => {
  const names = (role: 'viewer' | 'editor' | 'admin') => visibleNav((r) => r === 'editor' ? role !== 'viewer' : role === 'admin').map((g) => `${g.id}:${g.items.length}`);
  it('filters entries by role and drops empty groups', () => {
    expect(names('viewer')).toEqual(['watch:4', 'configure:2']);
    expect(names('editor')).toEqual(['watch:4', 'configure:5']);
    expect(names('admin')).toEqual(['watch:4', 'configure:5', 'system:3']);
  });
});

describe('api client', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('reports network failures as ApiError(0, "network")', async () => {
    const { api, ApiError } = await import('../../web/src/lib/api');
    const f = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const e = await api('GET', '/api/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(0);
    expect(e.code).toBe('network');
    f.mockRestore();
  });
  it('reloads the CSRF token once and retries after a csrf 403', async () => {
    const { api } = await import('../../web/src/lib/api');
    const calls: string[] = [];
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push(`${init?.method} ${String(url)} ${h['x-csrf-token'] ?? ''}`.trim());
      if (String(url) === '/api/auth/me') return res(200, { csrf: 'fresh' });
      return h['x-csrf-token'] === 'fresh' ? res(200, { ok: true }) : res(403, { error: 'csrf', message: 'Missing or invalid CSRF token' });
    });
    expect(await api('POST', '/api/y', {})).toEqual({ ok: true });
    expect(calls).toEqual(['POST /api/y', 'GET /api/auth/me', 'POST /api/y fresh']);
    f.mockRestore();
  });
});
