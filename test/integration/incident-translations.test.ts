import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
let loadMonitor: typeof import('../../src/server/monitors/service').loadMonitor; // imported after the harness has set the environment
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); ({ loadMonitor } = await import('../../src/server/monitors/service')); });
afterAll(async () => { await t?.close(); });

const monitor = async (name: string) => (await c.post('/api/monitors', { name, type: 'push', config: {} })).json.id as number;
const page = async (slug: string, monitorId: number, extra: object = {}) =>
  (await c.post('/api/status-pages', { slug, title: slug, isPublic: true, sections: [], components: [{ monitorId, displayName: 'Router' }], ...extra })).json.id as number;
type View = { incidents: { id: number; title: string; updates: { body: string | null; kind: string }[] }[]; announcements: { title: string; body: string | null }[] };
const view = async (slug: string, lang?: string) => (await t.client().get(`/api/public/status/${slug}${lang ? `?lang=${lang}` : ''}`)).json as View;

describe('incident texts in two languages', () => {
  it('shows the version for the visitor language and falls back to the text as written', async () => {
    const m = await monitor('tr-monitor');
    await page('tr', m);
    const id = (await c.post('/api/incidents', { title: 'Network outage', titleDe: 'Netzwerkstörung', monitorIds: [m], body: 'We are on it', bodyDe: 'Wir kümmern uns darum', public: true })).json.id as number;
    const shown = async (lang?: string) => { const i = (await view('tr', lang)).incidents[0]; return [i.title, i.updates.map((u) => u.body)] as const; };
    expect(await shown('de')).toEqual(['Netzwerkstörung', ['Wir kümmern uns darum']]);
    expect(await shown('en')).toEqual(['Network outage', ['We are on it']]); // no English version: the text as written
    expect(await shown()).toEqual(['Network outage', ['We are on it']]);

    // an English version only changes the English view; a German operator can write German as the default
    expect((await c.call('PATCH', `/api/incidents/${id}`, { titleEn: 'Network problem' })).status).toBe(200);
    expect((await shown('en'))[0]).toBe('Network problem');
    expect((await shown('de'))[0]).toBe('Netzwerkstörung');
    expect((await c.call('PATCH', `/api/incidents/${id}`, { titleEn: '  ' })).status).toBe(200); // empty removes the version again
    expect((await shown('en'))[0]).toBe('Network outage');
    expect((await c.get(`/api/incidents/${id}`)).json).toMatchObject({ title: 'Network outage', titleEn: null, titleDe: 'Netzwerkstörung' });

    // notes and status messages carry versions too, and a version can be changed afterwards
    await c.post(`/api/incidents/${id}/notes`, { body: 'Cause found', bodyDe: 'Ursache gefunden', status: 'identified' });
    await c.post(`/api/incidents/${id}/notes`, { body: 'Internal detail', public: true });
    const detail = (await c.get(`/api/incidents/${id}`)).json;
    const entry = detail.updates.find((u: any) => u.body === 'Internal detail');
    expect((await c.call('PATCH', `/api/incidents/${id}/updates/${entry.id}`, { bodyDe: 'Interne Angabe', bodyEn: 'Internal detail, revised' })).status).toBe(200);
    expect((await view('tr', 'de')).incidents[0].updates.map((u) => u.body)).toEqual(['Interne Angabe', 'Ursache gefunden', 'Wir kümmern uns darum']); // newest first
    expect((await view('tr', 'en')).incidents[0].updates.map((u) => u.body)).toEqual(['Internal detail, revised', 'Cause found', 'We are on it']);

    // the text the system writes for a manual resolve reads right in both languages
    await c.post(`/api/incidents/${id}/resolve`);
    expect((await view('tr', 'de')).incidents).toEqual([]); // resolved: listed under past incidents
    const past = async (lang: string) => ((await t.client().get(`/api/public/status/tr?lang=${lang}`)).json as any).recentIncidents[0].updates[0].body;
    expect(await past('de')).toBe('Manuell behoben');
    expect(await past('en')).toBe('Resolved manually');
  });

  it('lets the page language win and words detected incidents in the visitor language', async () => {
    const m = await monitor('tr-auto');
    await c.put('/api/settings/incidents', { autoPublish: true });
    await page('tr-free', m);
    await page('tr-fixed', m, { language: 'de' });
    await t.ctx.incidents.openFor((await loadMonitor(t.ctx, m))!, { ok: false, message: 'connection refused' });
    expect((await view('tr-free', 'de')).incidents[0].title).toBe('Router ist nicht erreichbar');
    expect((await view('tr-free', 'en')).incidents[0].title).toBe('Router is down');
    expect((await view('tr-free')).incidents[0].title).toBe('Router is down');
    expect((await view('tr-fixed', 'en')).incidents[0].title).toBe('Router ist nicht erreichbar'); // the fixed language ignores ?lang=
    expect((await t.client().get('/api/public/status/tr-free?lang=fr')).status).toBe(400);

    const rss = async (slug: string, lang: string) => (await t.client().get(`/api/public/status/${slug}/rss?lang=${lang}`)).body;
    const de = await rss('tr-free', 'de');
    expect(de).toContain('<language>de</language>');
    expect(de).toContain('[Laufend] Router ist nicht erreichbar');
    expect(await rss('tr-free', 'en')).toContain('[Ongoing] Router is down');
    await c.put('/api/settings/incidents', { autoPublish: false });
  });

  it('writes announcements in two languages and tells each subscriber in their own', async () => {
    const m = await monitor('tr-sub');
    const pageId = await page('tr-sub', m);
    const a = await c.post(`/api/status-pages/${pageId}/announcements`, { kind: 'info', title: 'Maintenance tonight', titleDe: 'Wartung heute Nacht', body: 'Short break', bodyDe: 'Kurze Pause' });
    expect(a.status).toBe(200);
    expect((await view('tr-sub', 'de')).announcements[0]).toMatchObject({ title: 'Wartung heute Nacht', body: 'Kurze Pause' });
    expect((await view('tr-sub', 'en')).announcements[0]).toMatchObject({ title: 'Maintenance tonight', body: 'Short break' });

    // two webhook subscribers that signed up in different languages receive the same incident in theirs
    const got: { lang: string; subject: string; text: string }[] = [];
    const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise<void>((ok) => sink.listen(0, '127.0.0.1', ok));
    const { encrypt } = await import('../../src/server/crypto');
    const { startSubscriberNotifications } = await import('../../src/server/routes/status-pages');
    const stop = startSubscriberNotifications(t.ctx);
    try {
      const url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
      for (const lang of ['de', 'en']) await t.ctx.db.insertInto('status_page_subscribers').values({ page_id: pageId, kind: 'webhook', target_enc: encrypt(url), target_hash: `h-${lang}`, token: `tok-${lang}`, verified: 1, lang }).execute();
      const id = (await c.post('/api/incidents', { title: 'Disk full', titleDe: 'Festplatte voll', monitorIds: [m], public: true })).json.id as number;
      for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      const by = Object.fromEntries(got.map((g) => [g.lang, g.subject]));
      expect(by).toEqual({ de: 'Störung: Festplatte voll', en: 'Incident: Disk full' });
      expect(id).toBeGreaterThan(0);
    } finally { stop(); await new Promise((r) => sink.close(r)); }
  });
});

describe('one language for the whole instance', () => {
  it('fixes status pages, feeds, subscriber mails, alerts and downloads to English or German only', async () => {
    const m = await monitor('mode-m');
    const pageId = await page('mode', m); // "visitor decides"
    await c.post('/api/incidents', { title: 'Fan failure', titleDe: 'Lüfterausfall', monitorIds: [m], public: true });
    const get = async (lang: string) => (await t.client().get(`/api/public/status/mode?lang=${lang}`)).json as { language: string | null; incidents: { title: string }[] };
    const set = async (mode: string) => (await c.put('/api/settings/languages', { mode })).status;
    const meta = async () => (await t.client().get('/api/meta')).json.languages;
    expect((await c.get('/api/settings/languages')).json).toEqual({ mode: 'both' });
    expect(await meta()).toBe('both');
    expect(await set('fr')).toBe(400);

    // German only: the visitor's pick is ignored, the page counts as fixed, feed and downloads follow
    expect(await set('de')).toBe(200);
    expect(await meta()).toBe('de');
    expect(await get('en')).toMatchObject({ language: 'de', incidents: [{ title: 'Lüfterausfall' }] });
    expect((await t.client().get('/api/public/status/mode/rss?lang=en')).body).toContain('<language>de</language>');
    expect((await c.get('/api/reports/sla?format=csv&lang=en')).body.replace(/^\uFEFF/, '').split('\r\n')[0]).toContain('Gruppe');
    const texts = await import('../../src/server/notify/texts');
    expect(await texts.notifyLang(t.ctx)).toEqual({ lang: 'de', explicit: true });
    expect([...(await texts.groupByLang(t.ctx, ['a@example.test', 'b@example.test']))]).toEqual([['de', ['a@example.test', 'b@example.test']]]);

    // subscribers who signed up in English still get the one language
    const got: { lang: string; subject: string }[] = [];
    const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise<void>((ok) => sink.listen(0, '127.0.0.1', ok));
    const { encrypt } = await import('../../src/server/crypto');
    const { notifySubscribers } = await import('../../src/server/routes/status-pages');
    try {
      const url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
      await t.ctx.db.insertInto('status_page_subscribers').values({ page_id: pageId, kind: 'webhook', target_enc: encrypt(url), target_hash: 'mode-en', token: 'tok-mode', verified: 1, lang: 'en' }).execute();
      await notifySubscribers(t.ctx, pageId, (lang) => ({ subject: lang === 'de' ? 'Störung' : 'Incident', text: '-' }));
      expect(got).toEqual([expect.objectContaining({ lang: 'de', subject: 'Störung' })]);
    } finally { await new Promise((r) => sink.close(r)); }

    // English only, then back to both
    expect(await set('en')).toBe(200);
    expect(await get('de')).toMatchObject({ language: 'en', incidents: [{ title: 'Fan failure' }] });
    expect(await set('both')).toBe(200);
    expect(await get('de')).toMatchObject({ language: null, incidents: [{ title: 'Lüfterausfall' }] });
  });
});
