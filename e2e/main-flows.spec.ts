import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/** Logs the API client in and returns the CSRF header plus the first monitor on the demo status page. */
async function apiSetup(request: APIRequestContext) {
  const auth = await request.post('/api/auth/login', { data: { username: 'admin', password: 'e2e-password-1' } });
  const headers = { 'x-csrf-token': (await auth.json()).csrf };
  const pages = await (await request.get('/api/status-pages')).json();
  const demo = pages.find((p: { slug: string }) => p.slug === 'demo');
  const full = await (await request.get(`/api/status-pages/${demo.id}`)).json();
  const monitorId = [...full.sections.flatMap((s: { components: unknown[] }) => s.components), ...full.components][0].monitorId;
  return { headers, demo, full, monitorId };
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('e2e-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('logs in and shows the demo monitors live', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Core router').first()).toBeVisible();
  await expect(page.getByText('10 monitors')).toBeVisible();
});

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('creates a push monitor and receives a heartbeat', async ({ page, request }) => {
  await login(page);
  await page.goto('/monitors/new');
  await page.getByLabel('Type').selectOption({ label: 'Push / heartbeat' });
  await page.getByLabel(/^Name/).fill('e2e nightly job');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('heading', { name: 'e2e nightly job' })).toBeVisible();
  const url = await page.getByText(/\/api\/push\//).first().innerText();
  const res = await request.get(url.trim().replace(/^https?:\/\/[^/]+/, ''));
  expect(res.ok()).toBe(true);
  await expect(page.getByText('Up', { exact: true }).first()).toBeVisible();
});

test('opens the command palette with Ctrl+K and navigates', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('combobox').fill('incidents');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/incidents/);
});

test('serves the public status page without a session', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/status/demo');
  await expect(page.getByRole('heading', { name: 'Demo Status' })).toBeVisible();
  await expect(page.getByText('Marketing site')).toBeVisible();
  await ctx.close();
});

test('opens a monitor from anywhere on its card and pauses it from the card', async ({ page }) => {
  await login(page);
  const card = page.locator('.card').filter({ hasText: 'Core router' }).first();
  await page.getByRole('button', { name: /^Pause: Core router/ }).click();
  await expect(page.getByRole('button', { name: /^Resume: Core router/ })).toBeVisible();
  await page.getByRole('button', { name: /^Resume: Core router/ }).click();
  await expect(page.getByRole('button', { name: /^Pause: Core router/ })).toBeVisible();
  const box = (await card.boundingBox())!;
  await card.click({ position: { x: 16, y: box.height - 8 } });
  await expect(page).toHaveURL(/\/monitors\/\d+$/);
});

test('adds several monitors at once with a live preview and creates a group inline', async ({ page }) => {
  await login(page);
  await page.goto('/monitors/new');
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Group name').fill('e2e group');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByLabel('Group', { exact: true })).toHaveValue(/\d+/);
  await page.getByRole('switch', { name: 'Add several monitors at once' }).click();
  await page.getByLabel('Targets').fill('Bulk One | https://one.example.com\nBulk Two | https://two.example.com\nBulk One | https://dup.example.com');
  await expect(page.getByText('duplicate in list')).toBeVisible();
  await page.getByRole('button', { name: 'Create 3 monitors' }).first().click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Bulk Two').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^e2e group/ })).toBeVisible();
});

test('offers ranges down to 15 minutes and requests the chart for it', async ({ page }) => {
  await login(page);
  await page.getByText('Core router').first().click();
  await expect(page).toHaveURL(/\/monitors\/\d+$/);
  const req = page.waitForRequest((r) => /\/chart\?range=15m/.test(r.url()));
  await page.getByLabel('Time range').selectOption({ label: 'Last 15 minutes' });
  await req;
});

test('serves the home page at "/" and keeps the admin behind /admin', async ({ page, browser }) => {
  await login(page);
  await page.goto('/status-pages');
  const row = page.getByRole('row', { name: /Demo Status/ });
  await row.getByRole('button', { name: /home page/i }).click();
  await expect(row.getByRole('button', { name: /home page/i })).toHaveAttribute('aria-pressed', 'true');

  const anon = await browser.newContext();
  const home = await anon.newPage();
  await home.goto('/');
  await expect(home.getByRole('heading', { name: 'Demo Status' })).toBeVisible();
  await home.goto('/admin');
  await expect(home).toHaveURL(/\/login/);
  await anon.close();

  await row.getByRole('button', { name: /home page/i }).click(); // leave the demo as it was
  await expect(row.getByRole('button', { name: /home page/i })).toHaveAttribute('aria-pressed', 'false');
});

test('a status page on its own domain is the start page there, the sign-in stays reachable', async ({ browser, request }) => {
  const { headers, demo, full } = await apiSetup(request);
  const save = (domain: string | null) => request.put(`/api/status-pages/${demo.id}`, { headers, data: { ...full, domain } });
  expect((await save('127.0.0.1')).ok()).toBe(true); // the host the tests use
  const anon = await browser.newContext();
  try {
    const page = await anon.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Demo Status' })).toBeVisible();
    for (const path of ['/dashboard', '/admin', '/login']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    }
  } finally {
    await save(null);
    await anon.close();
  }
});

test('an incident with an English and a German version reads in the language of the visitor', async ({ page, request, browser }) => {
  const { headers, monitorId } = await apiSetup(request);
  const stamp = Date.now();
  const id = (await (await request.post('/api/incidents', { headers, data: { title: `Cable cut ${stamp}`, titleDe: `Kabel durchtrennt ${stamp}`, severity: 'minor', monitorIds: [monitorId], public: true } })).json()).id as number;

  // the wording can be changed in the admin UI: the German version is there, and the English one can be added
  await login(page);
  await page.goto(`/incidents/${id}`);
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Wording on the status page' }) });
  await expect(card.getByLabel('German')).toHaveValue(`Kabel durchtrennt ${stamp}`);
  await card.getByLabel('English').fill(`Fibre cut ${stamp}`);
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Cable cut ${stamp}` })).toBeVisible(); // the title as written stays the default

  // a visitor who switches the language gets the matching wording
  const ctx = await browser.newContext({ locale: 'en-US' });
  const visitor = await ctx.newPage();
  await visitor.goto('/status/demo');
  await expect(visitor.getByRole('heading', { name: `Fibre cut ${stamp}` })).toBeVisible();
  await visitor.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'DE' }).click();
  await expect(visitor.getByRole('heading', { name: `Kabel durchtrennt ${stamp}` })).toBeVisible();
  await ctx.close();
  await request.post(`/api/incidents/${id}/resolve`, { headers });
});

test('the language setting reduces the whole instance to German only and back', async ({ page, request, browser }) => {
  const { headers, monitorId } = await apiSetup(request);
  const stamp = Date.now();
  const id = (await (await request.post('/api/incidents', { headers, data: { title: `Router reboot ${stamp}`, titleDe: `Router-Neustart ${stamp}`, severity: 'minor', monitorIds: [monitorId], public: true } })).json()).id as number;
  await login(page);
  await page.goto('/settings?tab=languages');
  await page.getByLabel('Languages', { exact: true }).selectOption('de');
  await expect(page.getByText('everything that is sent is German')).toBeVisible();
  try {
    // the second wording makes no sense with one language, so the form drops it
    await page.goto('/incidents');
    await page.getByRole('button', { name: 'New incident' }).click();
    await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
    await expect(page.getByText('English and German wording (optional)')).toHaveCount(0);

    // a visitor with an English browser gets the German page without a language switch
    const ctx = await browser.newContext({ locale: 'en-US' });
    const visitor = await ctx.newPage();
    await visitor.goto('/status/demo');
    await expect(visitor.getByRole('heading', { name: `Router-Neustart ${stamp}` })).toBeVisible();
    await expect(visitor.getByRole('group', { name: /^(Language|Sprache)$/ })).toHaveCount(0);
    await ctx.close();
  } finally {
    expect((await request.put('/api/settings/languages', { headers, data: { mode: 'both' } })).ok()).toBe(true);
    await request.post(`/api/incidents/${id}/resolve`, { headers });
  }
  await page.goto('/incidents');
  await page.getByRole('button', { name: 'New incident' }).click();
  await expect(page.getByText('English and German wording (optional)').first()).toBeVisible();
});

test('offers the newer monitor types in their groups and shows their fields', async ({ page }) => {
  await login(page);
  await page.goto('/monitors/new');
  const type = page.getByLabel('Type');
  for (const [group, label] of [['Games', 'Pelican / Pterodactyl server'], ['Games', 'AMP game server (CubeCoders)'], ['Network', 'NTP server'], ['Identity', 'RADIUS'], ['Passive', 'Manual status']]) {
    await expect(type.locator(`optgroup[label="${group}"] option`, { hasText: label })).toHaveCount(1);
  }
  await type.selectOption({ label: 'Pelican / Pterodactyl server' });
  await expect(page.getByLabel(/^Panel URL/)).toBeVisible();
  await expect(page.getByLabel(/^Client API key/)).toBeVisible();
});

test('adds tags with a name and a value, creating a new name and value through "Add new..."', async ({ page }) => {
  await login(page);
  await page.goto('/monitors/new');
  await page.getByLabel('Type').selectOption({ label: 'Push / heartbeat' });
  await page.getByLabel(/^Name/).fill('e2e tagged job');

  await page.getByRole('button', { name: 'Add tag with value' }).click();
  await page.getByLabel('Tag name').last().selectOption({ label: 'Add new...' });
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('heading', { name: 'New tag' })).toBeVisible();
  await dlg.getByLabel('Tag name').fill('region');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await expect(dlg).toBeHidden();
  await page.getByLabel('Tag value').last().selectOption({ label: 'Add new...' });
  await dlg.getByLabel('Tag value').fill('eu-west');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await expect(dlg).toBeHidden();

  // a name that already exists, with a value that other monitors already use (the demo tags its monitors with "team")
  await page.getByRole('button', { name: 'Add tag with value' }).click();
  await page.getByLabel('Tag name').last().selectOption({ label: 'team' });
  await page.getByLabel('Tag value').last().selectOption({ label: 'platform' });

  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('heading', { name: 'e2e tagged job' })).toBeVisible();
  await expect(page.getByText('region: eu-west')).toBeVisible();
  await expect(page.getByText('team: platform')).toBeVisible();
});

test('filters the recent checks by one or several statuses', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: /Checkout \(flaky\)/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Recent checks' })).toBeVisible();
  const heartbeats = (r: import('@playwright/test').Response, status?: string) => r.url().includes('/heartbeats?') && (status === undefined ? !r.url().includes('status=') : r.url().includes(`status=${status}`));
  await page.getByRole('button', { name: 'Filter by status' }).click();
  const down = page.waitForResponse((r) => heartbeats(r, '0'));
  await page.getByRole('checkbox', { name: 'Down' }).check();
  const body = await (await down).json();
  expect(body.items.length).toBeGreaterThan(0);
  expect(body.items.every((i: { status: number }) => i.status === 0)).toBe(true);
  await expect(page.getByRole('button', { name: 'Filter by status' })).toHaveText(/Down/);

  const both = page.waitForResponse((r) => heartbeats(r, '0,1') || heartbeats(r, '1,0'));
  await page.getByRole('checkbox', { name: 'Up' }).check();
  expect((await (await both).json()).statuses).toEqual(expect.arrayContaining([0, 1]));

  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.getByRole('button', { name: 'Filter by status' })).toHaveText(/All statuses/);
});

test('explains the latency percentiles in plain words', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: /Checkout \(flaky\)/ }).first().click();
  await expect(page.getByText('Typical (p50)').first()).toBeVisible();
  await expect(page.getByText(/half of the checks were faster/i).first()).toBeVisible();
});

test('fills the status page slug from the title until it is edited by hand', async ({ page }) => {
  await login(page);
  await page.goto('/status-pages');
  await page.getByRole('button', { name: 'New status page' }).first().click();
  const title = page.getByLabel('Title', { exact: true });
  const slug = page.getByLabel('URL slug');
  await title.fill('Public Services');
  await expect(slug).toHaveValue('public-services');
  await slug.fill('pub');
  await title.fill('Public Services EU');
  await expect(slug).toHaveValue('pub'); // a hand-made slug is left alone
  await slug.fill('');
  await title.fill('Öffentliche Dienste');
  await expect(slug).toHaveValue('oeffentliche-dienste'); // an emptied slug follows the title again
});

test('shows or hides an incident with one switch and tunes the past-incident settings', async ({ page, request }) => {
  const { headers, monitorId } = await apiSetup(request);
  const title = `visibility-test ${Date.now()}`;
  await request.post('/api/incidents', { headers, data: { title, severity: 'minor', monitorIds: [monitorId], public: true } });
  await login(page);
  await page.goto('/incidents');
  const row = page.locator('tbody tr').filter({ hasText: title });
  await expect(row.getByText('On status page')).toBeVisible();
  await row.getByRole('button', { name: 'Hide from status pages' }).click();
  await expect(row.getByText('On status page')).toBeHidden();
  await row.getByRole('button', { name: 'Show on status pages' }).click();
  await expect(row.getByText('On status page')).toBeVisible();

  await page.goto('/status-pages');
  await page.getByRole('button', { name: 'Edit: Demo Status' }).click();
  await expect(page.getByLabel('Show resolved incidents of the last')).toBeVisible();
  await page.getByRole('switch', { name: 'Show past incidents' }).click();
  await expect(page.getByLabel('Show resolved incidents of the last')).toBeHidden();
  await page.getByRole('switch', { name: 'Show past incidents' }).click();
  await expect(page.getByLabel('Incidents per page')).toBeVisible();
});

test('pages the past incidents on the public status page', async ({ page, request }) => {
  const { headers, monitorId } = await apiSetup(request);
  for (let n = 1; n <= 7; n++) {
    const inc = await (await request.post('/api/incidents', { headers, data: { title: `pager-test ${n}`, severity: 'minor', monitorIds: [monitorId], public: true } })).json();
    expect((await request.post(`/api/incidents/${inc.id}/resolve`, { headers })).ok()).toBe(true);
  }
  await page.goto('/status/demo');
  const cards = page.getByText(/^pager-test \d$/);
  await expect(page.getByRole('heading', { name: 'Past incidents' })).toBeVisible();
  await page.getByLabel('Per page').selectOption('5');
  await expect(cards).toHaveCount(5);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(cards).toHaveCount(2);
});

test('keeps new notes internal until they are shown, and lets you edit them afterwards', async ({ page, request }) => {
  const { headers, monitorId } = await apiSetup(request);
  const title = `notes-test ${Date.now()}`;
  const inc = await (await request.post('/api/incidents', { headers, data: { title, severity: 'minor', monitorIds: [monitorId], public: true } })).json();
  await login(page);
  await page.goto(`/incidents/${inc.id}`);
  await page.getByLabel('Add a note').fill('We are looking into the cache layer');
  await page.getByRole('button', { name: 'Save note' }).click();
  const entry = page.locator('li').filter({ hasText: 'We are looking into the cache layer' });
  await expect(entry.getByText('Internal')).toBeVisible();
  await page.goto('/status/demo');
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText('We are looking into the cache layer')).toHaveCount(0);

  await page.goto(`/incidents/${inc.id}`);
  await entry.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Edit' }).fill('Cache layer restarted, watching it');
  await page.locator('ol').getByRole('switch', { name: /^Show on the status page/ }).click();
  await page.locator('ol').getByRole('button', { name: 'Save', exact: true }).click();
  const edited = page.locator('li').filter({ hasText: 'Cache layer restarted, watching it' });
  await expect(edited.getByText('On status page')).toBeVisible();
  await expect(edited.getByText('edited')).toBeVisible();
  await page.goto('/status/demo');
  await expect(page.getByText('Cache layer restarted, watching it')).toBeVisible();
});

test('detected incidents stay internal unless the setting says otherwise', async ({ page, request }) => {
  const { headers } = await apiSetup(request);
  expect((await (await request.get('/api/settings/incidents')).json()).autoPublish).toBe(false);
  await login(page);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Incidents' }).click();
  const sw = page.getByRole('switch', { name: 'Show detected incidents on status pages' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect.poll(async () => (await (await request.get('/api/settings/incidents')).json()).autoPublish).toBe(true);
  await request.put('/api/settings/incidents', { headers, data: { autoPublish: false } });
});

test('the status page language can be fixed or left to the visitor', async ({ browser, request }) => {
  const { headers, demo, full } = await apiSetup(request);
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto('/status/demo');
  await expect(page.getByRole('heading', { name: 'Past incidents' })).toBeVisible();
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'DE' }).click();
  await expect(page.getByRole('heading', { name: 'Vergangene Störungen' })).toBeVisible();
  await page.goto('/status/demo?lang=en');
  await expect(page.getByRole('heading', { name: 'Past incidents' })).toBeVisible();

  const save = (language: string | null) => request.put(`/api/status-pages/${demo.id}`, { headers, data: { ...full, language } });
  expect((await save('de')).ok()).toBe(true);
  try {
    await page.goto('/status/demo');
    await expect(page.getByRole('heading', { name: 'Vergangene Störungen' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Sprache' })).toHaveCount(0); // a fixed language needs no switch
    expect(await (await request.get('/api/public/status/demo/rss')).text()).toMatch(/\[(Laufend|Behoben)\]/);
  } finally {
    await save(null);
    await ctx.close();
  }
});

test('shows the players of a game server on the dashboard and the status page', async ({ page, request, browser }) => {
  await apiSetup(request);
  await expect.poll(async () => ((await (await request.get('/api/monitors')).json()) as { name: string; info: unknown }[]).find((m) => m.name === 'Survival server')?.info != null, { timeout: 60_000 }).toBe(true);
  await login(page);
  await expect(page.locator('.card').filter({ hasText: 'Survival server' }).first().getByText(/\d+\/50|\d+ of 50 players/)).toBeVisible();
  const ctx = await browser.newContext();
  const pub = await ctx.newPage();
  await pub.goto('/status/demo');
  await expect(pub.getByText(/\d+ of 50 players online/)).toBeVisible();
  await expect(pub.getByText('1.21.1')).toBeVisible();
  await ctx.close();
});

test('the wall display keeps its settings in the address and rotates through the tiles', async ({ page }) => {
  await login(page);
  await page.goto('/kiosk?size=s&rotate=0&theme=light&view=problems');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog', { name: 'Wall display settings' });
  await expect(dialog.getByLabel('Tile size')).toHaveValue('s');
  await expect(dialog.getByLabel('Show', { exact: true })).toHaveValue('problems');
  await dialog.getByLabel('Show', { exact: true }).selectOption('all');
  await dialog.getByLabel('Switch pages').selectOption('0');
  await dialog.getByLabel('Tile size').selectOption('l');
  await expect(page).toHaveURL(/size=l/);
  await expect(page).not.toHaveURL(/view=/);
  await dialog.getByText('Close', { exact: true }).click();
  await expect(page.getByText(/^Page 1 of \d+$/)).toBeVisible(); // large tiles do not fit on one page
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(/^Page 2 of \d+$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/dashboard/);
});

test('the wall display shows only the picked monitors, grouped with a heading per group', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 }); // tall enough for every group on one page
  await login(page);
  await page.goto('/kiosk?layout=grouped&rotate=0&size=s');
  for (const g of ['Web', 'Web / APIs', 'Infrastructure', 'Data']) await expect(page.getByRole('heading', { level: 2, name: g, exact: true })).toBeVisible(); // a subgroup carries its path
  await expect(page.getByText(/^\d+ of \d+ up$/).first()).toBeVisible();

  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog', { name: 'Wall display settings' });
  await dialog.getByRole('checkbox', { name: /Core router/ }).check();
  await dialog.getByRole('checkbox', { name: /Marketing site/ }).check();
  await expect(page).toHaveURL(/monitors=\d+%2C\d+/);
  await dialog.getByText('Close', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Infrastructure', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Web', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Data', exact: true })).toHaveCount(0);
  await expect(page.getByText('Public API')).toHaveCount(0);

  await page.reload(); // the address alone restores the whole display
  await expect(page.getByRole('heading', { level: 2, name: 'Web', exact: true })).toBeVisible();
  await expect(page.getByText('Public API')).toHaveCount(0);
});

test('the wall display zoom scales the whole page, can be changed by key and is undone on exit', async ({ page }) => {
  await login(page);
  const fontSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  await page.goto('/kiosk?zoom=150');
  await expect.poll(fontSize).toBe('24px');
  await page.keyboard.press('-');
  await expect.poll(fontSize).toBe('22.4px');
  await expect(page).toHaveURL(/zoom=140/);
  await page.keyboard.press('0');
  await expect.poll(fontSize).toBe('16px');
  await page.keyboard.press('+');
  await expect.poll(fontSize).toBe('17.6px');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect.poll(fontSize).toBe('16px');
  await page.goto('/kiosk?zoom=999'); // out of range: ignored
  await expect.poll(fontSize).toBe('16px');
});

test('sets the language of notifications and emails on the notifications page', async ({ page, request }) => {
  const { headers } = await apiSetup(request);
  await login(page);
  await page.goto('/notifications');
  const select = page.getByLabel('Language of notifications and emails');
  await select.selectOption('de');
  await expect.poll(async () => (await (await request.get('/api/settings/notifications')).json()).language).toBe('de');
  await page.reload();
  await expect(select).toHaveValue('de');
  await request.put('/api/settings/notifications', { headers, data: { language: 'en' } });
});

test('sets interval, retries, retry interval and timeout like in Uptime Kuma', async ({ page, request }) => {
  await login(page);
  await page.goto('/monitors/new');
  await page.getByLabel('Type').selectOption({ label: 'Push / heartbeat' });
  await page.getByLabel(/^Name/).fill('e2e retry policy');
  const field = (name: string) => page.getByLabel(name, { exact: true });
  // a new monitor starts with Kuma's timing: timeout 80% of the interval, retry as often as a check
  await expect(field('Request timeout')).toHaveValue('48');
  await expect(field('Heartbeat retry interval')).toHaveValue('60');
  // the retry interval follows the interval while both are equal; a timeout that is too long is cut to 80% when the field is left
  await field('Heartbeat interval').fill('30');
  await expect(field('Heartbeat retry interval')).toHaveValue('30');
  await field('Heartbeat interval').blur();
  await expect(field('Request timeout')).toHaveValue('24');
  await expect(page.getByText('Check every 30 seconds')).toBeVisible();
  await field('Retries').fill('3');
  await field('Heartbeat retry interval').fill('20');
  await field('Request timeout').fill('10');
  // worst case: 4 attempts of 10 s plus 3 waits of 20 s = 100 s
  await expect(page.getByTestId('retry-summary')).toContainText('1m 40s');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('heading', { name: 'e2e retry policy' })).toBeVisible();
  await expect(page.getByText('3 × 20s')).toBeVisible();
  await apiSetup(request); // signs the API client in
  const id = (await (await request.get('/api/monitors')).json()).find((m: { name: string }) => m.name === 'e2e retry policy').id;
  const saved = await (await request.get(`/api/monitors/${id}`)).json();
  expect([saved.intervalS, saved.timeoutS, saved.retries, saved.retryIntervalS]).toEqual([30, 10, 3, 20]);
});

test('a monitor in retry shows a yellow block and is only reported as down after the last retry', async ({ page, request }) => {
  const { headers } = await apiSetup(request);
  const made = await request.post('/api/monitors', { headers, data: { name: 'e2e retrying', type: 'tcp', config: { host: 'nonexistent.invalid', port: 80 }, intervalS: 3600, timeoutS: 5, retries: 2, retryIntervalS: 60 } });
  const id = (await made.json()).id;
  const check = () => request.post(`/api/monitors/${id}/check`, { headers });
  const status = async () => ((await (await request.get('/api/monitors')).json()) as { id: number; status: string }[]).find((m) => m.id === id)?.status;
  await check();
  await login(page);
  await page.goto(`/monitors/${id}`);
  await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[role=img] span.bg-amber-500').first()).toHaveAttribute('title', /Pending$/);
  await check();
  expect(await status()).toBe('pending'); // first failure plus one retry: still not reported as offline
  await check();
  expect(await status()).toBe('down'); // the last retry failed
});
