import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedInAdmin, startApp, type TestApp } from './harness';

let t: TestApp;
let c: Awaited<ReturnType<typeof loggedInAdmin>>;
beforeAll(async () => { t = await startApp(); c = await loggedInAdmin(t); });
afterAll(async () => { await t?.close(); });

describe('notification language', () => {
  it('follows the setting, else the administrator profile language, else English', async () => {
    const lang = async () => (await c.get('/api/settings/notifications')).json;
    expect(await lang()).toEqual({ language: 'en', explicit: false });
    await t.ctx.db.updateTable('users').set({ locale: 'de' }).execute();
    expect(await lang()).toEqual({ language: 'de', explicit: false });
    expect((await c.put('/api/settings/notifications', { language: 'en' })).status).toBe(200);
    expect(await lang()).toEqual({ language: 'en', explicit: true }); // an explicit choice wins over the profile
    expect((await c.put('/api/settings/notifications', { language: 'fr' })).status).toBe(400);
  });

  it('writes alerts, test messages and the digest in that language', async () => {
    const { parseMonitor } = await import('../../src/server/monitors/model');
    const { buildDigest } = await import('../../src/server/reports');
    const id = (await c.post('/api/monitors', { name: 'lang-monitor', type: 'push', config: {} })).json.id as number;
    const monitor = parseMonitor(await t.ctx.db.selectFrom('monitors').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
    const down = { event: 'down' as const, monitor, result: { ok: false, message: 'timeout' } as any };

    const en = t.ctx.notifier.buildMessage(down, null, 'en');
    expect([en.subject, en.text.split('\n').slice(0, 2)]).toEqual(['[DOWN] lang-monitor', ['lang-monitor is down.', 'Reason: timeout']]);
    const de = t.ctx.notifier.buildMessage(down, null, 'de');
    expect([de.subject, de.text.split('\n').slice(0, 2)]).toEqual(['[OFFLINE] lang-monitor', ['lang-monitor ist nicht erreichbar.', 'Grund: timeout']]);
    expect(t.ctx.notifier.buildMessage({ event: 'up', monitor }, null, 'de').text).toContain('ist wieder erreichbar');

    // a template written by the admin is sent as written, whatever the language
    expect(t.ctx.notifier.buildMessage(down, { subject: 'ALERT {{monitor.name}}', body: 'x' }, 'de').subject).toBe('ALERT lang-monitor');

    // the test button uses the configured language and stores what it sent
    const ch = (await t.ctx.db.insertInto('notification_channels').values({ name: 'c', type: 'webhook', config_enc: '{}', active: 1 } as any).executeTakeFirstOrThrow()).insertId!;
    const sent = async () => { await c.post(`/api/notification-channels/${ch}/test`); return JSON.parse((await t.ctx.db.selectFrom('notification_deliveries').select('payload').orderBy('id', 'desc').executeTakeFirstOrThrow()).payload!).text as string; };
    await c.put('/api/settings/notifications', { language: 'de' });
    expect(await sent()).toContain('Das ist eine Testbenachrichtigung');
    expect((await buildDigest(t.ctx)).subject).toContain('Tagesübersicht');
    await c.put('/api/settings/notifications', { language: 'en' });
    expect(await sent()).toContain('This is a test notification');
    expect((await buildDigest(t.ctx)).subject).toContain('daily digest');
  });
});

describe('language per user and in attachments', () => {
  const addUser = (name: string, locale: string | null) => t.ctx.db.insertInto('users').values({ username: name, display_name: name, email: `${name}@example.test`, role: 'viewer', is_active: 1, locale } as any).execute();

  it('sends each recipient the language of their own profile, the rest the instance language', async () => {
    const { groupByLang } = await import('../../src/server/notify/texts');
    await addUser('anna', 'de'); await addUser('ben', 'en'); await addUser('chris', null);
    const emails = ['anna@example.test', 'BEN@example.test', 'chris@example.test', 'nobody@example.test'];
    const split = async () => Object.fromEntries([...(await groupByLang(t.ctx, emails))].map(([l, v]) => [l, v.sort()]));
    await c.put('/api/settings/notifications', { language: 'en' });
    expect(await split()).toEqual({ de: ['anna@example.test'], en: ['BEN@example.test', 'chris@example.test', 'nobody@example.test'] });
    await c.put('/api/settings/notifications', { language: 'de' });
    expect(await split()).toEqual({ de: ['anna@example.test', 'chris@example.test', 'nobody@example.test'], en: ['BEN@example.test'] });
  });

  it('gives downloads and the digest preview the language of the signed-in person', async () => {
    await c.put('/api/settings/notifications', { language: 'en' });
    await t.ctx.db.updateTable('users').set({ locale: 'de' }).where('username', '=', 'admin').execute();
    const csv = await c.get('/api/reports/sla?format=csv');
    expect(csv.body.charCodeAt(0)).toBe(0xfeff); // German files carry a BOM so Excel reads the umlauts
    expect(csv.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('Monitor,Gruppe,Verfügbarkeit %,Ausfallzeit (min),Vorfälle,MTTR (min),Ø Antwortzeit (ms),p95-Antwortzeit (ms),Prüfungen');
    const forced = await c.get('/api/reports/sla?format=csv&lang=en');
    expect(forced.body.split('\r\n')[0]).toBe('Monitor,Group,Uptime %,Downtime (min),Incidents,MTTR (min),Avg latency (ms),p95 latency (ms),Checks');
    expect(forced.body.charCodeAt(0)).not.toBe(0xfeff); // English files stay byte-identical to before
    expect((await c.post('/api/settings/digest/preview', {})).json.subject).toContain('Tagesübersicht');
    await t.ctx.db.updateTable('users').set({ locale: null }).where('username', '=', 'admin').execute();
    expect((await c.post('/api/settings/digest/preview', {})).json.subject).toContain('daily digest');
  });

  it('renders the PDF in both languages', async () => {
    const { buildSla, slaPdf } = await import('../../src/server/reports');
    const rep = await buildSla(t.ctx, { type: 'all' }, 7);
    for (const lang of ['en', 'de'] as const) expect((await slaPdf(rep, lang)).subarray(0, 4).toString()).toBe('%PDF');
  });
});

