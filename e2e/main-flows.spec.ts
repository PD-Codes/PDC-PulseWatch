import { expect, test, type Page } from '@playwright/test';

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
  await expect(page.getByText('9 monitors')).toBeVisible();
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

test('hides an incident from the dashboard and tunes the past-incident settings', async ({ page }) => {
  await login(page);
  await page.goto('/incidents');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  const first = rows.first();
  await first.getByRole('button', { name: 'Hide from status pages' }).click();
  await expect(first.getByText('Hidden')).toBeVisible();
  await first.getByRole('button', { name: 'Show on status pages' }).click();
  await expect(first.getByText('Hidden')).toBeHidden();

  await page.goto('/status-pages');
  await page.getByRole('button', { name: 'Edit: Demo Status' }).click();
  await expect(page.getByLabel('Show resolved incidents of the last')).toBeVisible();
  await page.getByRole('switch', { name: 'Show past incidents' }).click();
  await expect(page.getByLabel('Show resolved incidents of the last')).toBeHidden();
  await page.getByRole('switch', { name: 'Show past incidents' }).click();
  await expect(page.getByLabel('Incidents per page')).toBeVisible();
});

test('pages the past incidents on the public status page', async ({ page, request }) => {
  const auth = await request.post('/api/auth/login', { data: { username: 'admin', password: 'e2e-password-1' } });
  const headers = { 'x-csrf-token': (await auth.json()).csrf };
  const pages = await (await request.get('/api/status-pages')).json();
  const demo = pages.find((p: { slug: string }) => p.slug === 'demo');
  const full = await (await request.get(`/api/status-pages/${demo.id}`)).json();
  const monitorId = [...full.sections.flatMap((s: { components: unknown[] }) => s.components), ...full.components][0].monitorId;
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
