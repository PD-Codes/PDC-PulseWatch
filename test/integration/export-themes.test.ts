// CSV export of heartbeats and events, themes (instance default, per user, per status page), import/export of the new fields,
// status page history in local days of PW_TIMEZONE, and resume spreading the next round over the interval.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

const TZ = 'America/New_York';
const prevTz = process.env.PW_TIMEZONE;
let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;

beforeAll(async () => {
  process.env.PW_TIMEZONE = TZ; // read by config at import time, which startApp does
  t = await startApp();
  c = await loggedInAdmin(t);
});
afterAll(async () => {
  await t?.close();
  if (prevTz === undefined) delete process.env.PW_TIMEZONE; else process.env.PW_TIMEZONE = prevTz;
});

const db = () => t.ctx.db;
const push = async (name: string, extra: object = {}) => (await c.post('/api/monitors', { name, type: 'push', config: {}, ...extra })).json;
const login = async (username: string, role: string, scopeRestricted = false) => {
  await c.post('/api/users', { username, password: `${username}-password-123`, role, scopeRestricted });
  const u = t.client();
  expect((await u.post('/api/auth/login', { username, password: `${username}-password-123` })).status).toBe(200);
  return u;
};
const lines = (body: string) => body.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);

describe('CSV export', () => {
  let m: any;
  const base = Date.parse('2026-11-01T10:00:00.000Z');
  const from = '2026-11-01T00:00:00.000Z', to = '2026-11-02T00:00:00.000Z';
  beforeAll(async () => {
    m = await push('csv-mon');
    const probe = Number((await db().insertInto('probes').values({ name: 'Frankfurt', token_hash: 'x'.repeat(64) }).executeTakeFirstOrThrow()).insertId);
    const msgs = ['ok', '=HYPERLINK("http://evil")', '+1+2', '-3', '@SUM(A1)', '\tTAB', '\rCR', 'a, "quoted" text', 'line\nbreak'];
    await db().insertInto('heartbeats').values(msgs.map((message, i) => ({ monitor_id: m.id, location_id: i === 1 ? probe : i === 2 ? 4294967295 : 0, ts: new Date(base + i * 60_000), status: i % 5, latency_ms: i === 0 ? 42 : null, error_kind: i ? 'refused' : null, message }))).execute();
    // outside the window and another monitor's rows
    await db().insertInto('heartbeats').values([{ monitor_id: m.id, ts: new Date(Date.parse(to) + 1000), status: 1, message: 'later' }, { monitor_id: m.id + 1000, ts: new Date(base), status: 1, message: 'other' }]).execute();
    await db().insertInto('events').values([
      { monitor_id: m.id, ts: new Date(base), type: 'status_change', from_status: 'up', to_status: 'down', error_kind: 'refused', message: '=cmd|calc' },
      { monitor_id: m.id, ts: new Date(base + 1000), type: 'check_error', error_kind: 'timeout', message: 'slow' },
    ]).execute();
  });

  it('exports heartbeats with the agreed columns, location names and formula injection neutralized', async () => {
    const r = await c.get(`/api/monitors/${m.id}/export.csv?kind=heartbeats&from=${from}&to=${to}&lang=en`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="pulsewatch-${m.id}-heartbeats-20261101T000000Z-20261102T000000Z.csv"`);
    expect(r.headers['x-pulsewatch-truncated']).toBe('false');
    expect(r.body.startsWith('\uFEFF')).toBe(false); // English: no byte order mark
    expect(r.body.split('\r\n').slice(0, 4)).toEqual([
      'ts,status,latency_ms,error_kind,message,location',
      '2026-11-01T10:00:00.000Z,down,42,,ok,overall',
      `2026-11-01T10:01:00.000Z,up,,refused,"'=HYPERLINK(""http://evil"")",Frankfurt`,
      "2026-11-01T10:02:00.000Z,pending,,refused,'+1+2,Server",
    ]);
    expect(r.body).toContain(",maintenance,,refused,'-3,overall\r\n");
    expect(r.body).toContain(",suppressed,,refused,'@SUM(A1),overall\r\n");
    expect(r.body).toContain(",down,,refused,'\tTAB,overall\r\n");
    expect(r.body).toContain(`,up,,refused,"'\rCR",overall\r\n`);
    expect(r.body).toContain(',"a, ""quoted"" text",overall\r\n');
    expect(r.body).toContain(',"line\nbreak",overall\r\n');
    expect(r.body).not.toContain('later');
    expect(r.body).not.toContain('other');
  });

  it('exports events, and German files carry a byte order mark and German column names', async () => {
    const r = await c.get(`/api/monitors/${m.id}/export.csv?kind=events&from=${from}&to=${to}&lang=de`);
    expect(r.status).toBe(200);
    expect(r.body.startsWith('\uFEFFZeitpunkt,Typ,Von Status,Zu Status,Fehlerart,Meldung\r\n')).toBe(true);
    expect(lines(r.body).slice(1)).toEqual(["2026-11-01T10:00:00.000Z,status_change,up,down,refused,'=cmd|calc", '2026-11-01T10:00:01.000Z,check_error,,,timeout,slow']);
    const en = await c.get(`/api/monitors/${m.id}/export.csv?kind=events&from=${from}&to=${to}&lang=en`);
    expect(lines(en.body)[0]).toBe('ts,type,from_status,to_status,error_kind,message');
    const hb = await c.get(`/api/monitors/${m.id}/export.csv?kind=heartbeats&from=${from}&to=${to}&lang=de`);
    expect(lines(hb.body)[0]).toBe('Zeitpunkt,Status,Antwortzeit (ms),Fehlerart,Meldung,Standort');
    expect(lines(hb.body)[1]).toBe('2026-11-01T10:00:00.000Z,down,42,,ok,gesamt');
  });

  it('reads in pages and stops at the row cap, saying so in a header', async () => {
    const { CSV_EXPORT } = await import('../../src/server/csv-export');
    const saved = { ...CSV_EXPORT };
    try {
      CSV_EXPORT.pageSize = 2;
      const all = await c.get(`/api/monitors/${m.id}/export.csv?kind=heartbeats&from=${from}&to=${to}&lang=en`);
      expect(all.headers['x-pulsewatch-truncated']).toBe('false');
      expect(all.body.match(/^2026-/gm)?.length).toBe(9);
      CSV_EXPORT.maxRows = 5;
      const cut = await c.get(`/api/monitors/${m.id}/export.csv?kind=heartbeats&from=${from}&to=${to}&lang=en`);
      expect(cut.headers['x-pulsewatch-truncated']).toBe('true');
      expect(cut.body.match(/^2026-/gm)?.length).toBe(5);
      expect(cut.body).toContain(",maintenance,,refused,'-3,overall\r\n"); // the fourth row; the first five come in order
      CSV_EXPORT.maxRows = 9;
      expect((await c.get(`/api/monitors/${m.id}/export.csv?kind=heartbeats&from=${from}&to=${to}`)).headers['x-pulsewatch-truncated']).toBe('false');
    } finally { Object.assign(CSV_EXPORT, saved); }
  });

  it('checks the window and the right to see the monitor', async () => {
    expect((await c.get(`/api/monitors/${m.id}/export.csv?from=${to}&to=${from}`)).status).toBe(400);
    expect((await c.get(`/api/monitors/${m.id}/export.csv?from=yesterday`)).status).toBe(400);
    expect((await c.get(`/api/monitors/${m.id}/export.csv?kind=pings`)).status).toBe(400);
    expect((await c.get('/api/monitors/999999/export.csv')).status).toBe(404);
    const viewer = await login('csv-viewer', 'viewer');
    expect((await viewer.get(`/api/monitors/${m.id}/export.csv?from=${from}&to=${to}`)).status).toBe(200);
    const restricted = await login('csv-restricted', 'viewer', true);
    expect((await restricted.get(`/api/monitors/${m.id}/export.csv?from=${from}&to=${to}`)).status).toBe(404);
    expect((await t.client().get(`/api/monitors/${m.id}/export.csv`)).status).toBe(401);
  });
});

describe('themes', () => {
  it('instance default in /api/meta and the admin setting', async () => {
    expect((await t.client().get('/api/meta')).json.defaultTheme).toBe('classic');
    expect((await c.get('/api/settings/appearance')).json).toEqual({ defaultTheme: 'classic' });
    expect((await c.put('/api/settings/appearance', { defaultTheme: 'nord' })).json).toEqual({ defaultTheme: 'nord' });
    expect((await c.get('/api/settings/appearance')).json).toEqual({ defaultTheme: 'nord' });
    expect((await t.client().get('/api/meta')).json.defaultTheme).toBe('nord');
    expect((await c.put('/api/settings/appearance', { defaultTheme: 'neon' })).status).toBe(400);
    const editor = await login('theme-editor', 'editor');
    expect((await editor.get('/api/settings/appearance')).status).toBe(403);
    expect((await editor.put('/api/settings/appearance', { defaultTheme: 'mono' })).status).toBe(403);
    expect(await db().selectFrom('audit_log').select('details').where('action', '=', 'settings.appearance').executeTakeFirst()).toEqual({ details: '{"defaultTheme":"nord"}' });
  });

  it('a user picks a theme of their own; the light/dark mode stays a separate field', async () => {
    expect((await c.get('/api/auth/me')).json).toMatchObject({ uiTheme: null, theme: 'system' });
    expect((await c.call('PATCH', '/api/auth/me', { uiTheme: 'lcars' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).json).toMatchObject({ uiTheme: 'lcars', theme: 'system' });
    await c.call('PATCH', '/api/auth/me', { theme: 'dark' });
    expect((await c.get('/api/auth/me')).json).toMatchObject({ uiTheme: 'lcars', theme: 'dark' });
    expect((await c.call('PATCH', '/api/auth/me', { uiTheme: 'bogus' })).status).toBe(400);
    await c.call('PATCH', '/api/auth/me', { uiTheme: null });
    expect((await c.get('/api/auth/me')).json.uiTheme).toBeNull();
  });

  it('a status page has its own theme, in the admin API and the public payload', async () => {
    const m = await push('theme-page-mon');
    const page = { slug: 'themed', title: 'Themed', isPublic: true, sections: [{ name: 'Main', components: [{ monitorId: m.id }] }] };
    const created = await c.post('/api/status-pages', { ...page, theme: 'terminal' });
    expect(created.json.theme).toBe('terminal');
    expect((await c.get(`/api/status-pages/${created.json.id}`)).json.theme).toBe('terminal');
    expect((await t.client().get('/api/public/status/themed')).json.theme).toBe('terminal');
    expect((await c.put(`/api/status-pages/${created.json.id}`, page)).json.theme).toBe('terminal'); // not sent: kept
    expect((await c.put(`/api/status-pages/${created.json.id}`, { ...page, theme: 'matrix' })).status).toBe(400);
    expect((await c.put(`/api/status-pages/${created.json.id}`, { ...page, theme: null })).json.theme).toBeNull();
    expect((await t.client().get('/api/public/status/themed')).json.theme).toBeNull();
  });
});

describe('config export and import', () => {
  it('carries the SLO target and the status page theme, but not the snooze; older documents keep both', async () => {
    const m = await push('port-mon', { sloTarget: 99.95 });
    await c.post(`/api/monitors/${m.id}/snooze`, { minutes: 30 });
    const page = await c.post('/api/status-pages', { slug: 'port-page', title: 'Port', isPublic: true, theme: 'cyberpunk', sections: [{ name: 'S', components: [{ monitorId: m.id }] }] });
    const exp = await c.get('/api/config/export?format=json');
    expect(exp.status).toBe(200);
    const doc = JSON.parse(exp.body);
    const dm = doc.monitors.find((x: any) => x.name === 'port-mon');
    expect(dm.sloTarget).toBe(99.95);
    expect(JSON.stringify(doc)).not.toMatch(/snooze/i);
    expect(doc.statusPages.find((p: any) => p.slug === 'port-page').theme).toBe('cyberpunk');

    await c.call('PATCH', `/api/monitors/${m.id}`, { sloTarget: 90 });
    await c.put(`/api/status-pages/${page.json.id}`, { slug: 'port-page', title: 'Port', isPublic: true, theme: 'mono', sections: [{ name: 'S', components: [{ monitorId: m.id }] }] });
    const imp = await c.post('/api/config/import', { content: JSON.stringify(doc) });
    expect(imp.json.errors).toEqual([]);
    expect((await c.get(`/api/monitors/${m.id}`)).json.sloTarget).toBe(99.95);
    expect((await c.get(`/api/status-pages/${page.json.id}`)).json.theme).toBe('cyberpunk');

    // a document from before these fields: nothing is reset
    const old = JSON.parse(exp.body);
    for (const x of old.monitors) delete x.sloTarget;
    for (const p of old.statusPages) delete p.theme;
    old.monitors.push({ ...old.monitors.find((x: any) => x.name === 'port-mon'), name: 'port-new' });
    old.statusPages.push({ ...old.statusPages.find((p: any) => p.slug === 'port-page'), slug: 'port-new-page' });
    const imp2 = await c.post('/api/config/import', { content: JSON.stringify(old) });
    expect(imp2.json.errors).toEqual([]);
    expect((await c.get(`/api/monitors/${m.id}`)).json.sloTarget).toBe(99.95);
    expect((await c.get(`/api/status-pages/${page.json.id}`)).json.theme).toBe('cyberpunk');
    const created = (await c.get('/api/monitors')).json.find((x: any) => x.name === 'port-new');
    expect(created.sloTarget).toBeNull();
    expect(created.snoozedUntil).toBeNull();
    expect((await t.client().get('/api/public/status/port-new-page')).json.theme).toBeNull();

    // invalid values are reported and left out
    const bad = JSON.parse(exp.body);
    bad.monitors.find((x: any) => x.name === 'port-mon').sloTarget = 120;
    bad.statusPages.find((p: any) => p.slug === 'port-page').theme = 'neon';
    const imp3 = await c.post('/api/config/import', { content: JSON.stringify(bad) });
    expect(imp3.json.errors).toEqual([]);
    expect(imp3.json.warnings.join('\n')).toMatch(/SLO target 120 is not valid[\s\S]*unknown theme "neon"/);
    expect((await c.get(`/api/monitors/${m.id}`)).json.sloTarget).toBe(99.95);
  });
});

describe('status page history in PW_TIMEZONE', () => {
  it('groups the hourly rollups into local days', async () => {
    const { addDays, dayStart, localDate } = await import('../../src/server/tz');
    const m = await push('tz-mon');
    await c.post('/api/status-pages', { slug: 'tz-page', title: 'TZ', isPublic: true, showHistory: true, historyDays: 14, sections: [{ name: 'S', components: [{ monitorId: m.id }] }] });
    const today = localDate(TZ, new Date());
    const yesterday = addDays(today, -1), before = addDays(today, -2);
    const midnight = dayStart(TZ, yesterday).getTime();
    // 22:00 local the evening before (same UTC date as the next morning) is down, 01:00 local is up
    await db().insertInto('rollups').values([
      { monitor_id: m.id, res: 'hour', bucket: new Date(midnight - 2 * 3_600_000), total: 10, up_n: 0, down_n: 10 },
      { monitor_id: m.id, res: 'hour', bucket: new Date(midnight + 3_600_000), total: 10, up_n: 10, down_n: 0 },
    ]).execute();
    const comp = (await t.client().get('/api/public/status/tz-page')).json.sections[0].components[0];
    expect(comp.daily).toHaveLength(14);
    expect(comp.daily.at(-1).date).toBe(today);
    expect(comp.daily.find((d: any) => d.date === yesterday).uptime).toBe(100);
    expect(comp.daily.find((d: any) => d.date === before).uptime).toBe(0);
    expect(comp.uptime).toBe(50);
  });
});

describe('resume', () => {
  it('spreads the next round over the interval instead of running everything at once', async () => {
    const ms = await Promise.all(Array.from({ length: 6 }, (_, i) => push(`resume-${i}`, { intervalS: 600, active: false })));
    const t0 = Date.now();
    expect((await c.post('/api/monitors/bulk', { ids: ms.map((x) => x.id), action: 'resume' })).json.affected).toBe(6);
    const single = await push('resume-single', { intervalS: 3600, active: false });
    expect((await c.post(`/api/monitors/${single.id}/resume`)).status).toBe(200);
    const rows = await db().selectFrom('monitors').select(['id', 'active', 'next_run_at', 'interval_s']).where('id', 'in', [...ms.map((x) => x.id), single.id]).execute();
    for (const r of rows) {
      expect(r.active).toBe(1);
      const at = r.next_run_at!.getTime() - t0;
      expect(at).toBeGreaterThanOrEqual(900);
      expect(at).toBeLessThanOrEqual(r.interval_s * 1000 + 2000);
    }
    expect(new Set(rows.map((r) => r.next_run_at!.getTime())).size).toBeGreaterThan(1);
  });
});
