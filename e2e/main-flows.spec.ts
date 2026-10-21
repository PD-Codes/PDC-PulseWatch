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
