import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('e2e-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('the dashboard offers five views, splits them by group on demand and keeps the choice in the address', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  const views = page.getByRole('group', { name: 'View' });

  await views.getByRole('button', { name: 'Groups' }).click();
  await expect(page).toHaveURL(/display=groups/);
  await expect(page.getByText('Web / APIs').first()).toBeVisible(); // a subgroup block is named by its path
  await expect(page.getByRole('button', { name: 'Grouped' })).toHaveCount(0); // the group overview is always grouped

  await views.getByRole('button', { name: 'Wall' }).click();
  await expect(page).toHaveURL(/display=wall/);
  await expect(page.getByRole('link', { name: /Core router/ }).first()).toBeVisible();
  const grouped = page.getByRole('button', { name: 'Grouped' });
  await expect(grouped).toHaveAttribute('aria-pressed', 'true'); // the wall starts grouped
  await grouped.click();
  await expect(page).toHaveURL(/grouped=0/);

  await views.getByRole('button', { name: 'Heatmap' }).click();
  await expect(page).toHaveURL(/display=heatmap/);
  await expect(page.getByRole('list', { name: 'Colors of the hours' })).toBeVisible();
  await page.reload(); // the address alone restores the view
  await expect(views.getByRole('button', { name: 'Heatmap' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/dashboard'); // without parameters this device remembers the last view
  await expect(views.getByRole('button', { name: 'Heatmap' })).toHaveAttribute('aria-pressed', 'true');
  await views.getByRole('button', { name: 'Cards' }).click();
});

test('a wall display preset opens by its shortcut, and a kiosk key shows it without signing in until it is revoked', async ({ page, browser }) => {
  await login(page);
  await page.goto('/settings?tab=kiosk');
  await page.getByRole('button', { name: 'New preset' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New preset' });
  await editor.getByLabel('Name').fill('NOC e2e');
  await expect(editor.getByLabel('Shortcut')).toHaveValue('noc-e2e'); // follows the name until edited
  await editor.getByLabel('Display').selectOption('table');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('?preset=noc-e2e')).toBeVisible();

  // the default preset is what a plain /kiosk opens
  await page.getByLabel('Default preset').selectOption({ label: 'NOC e2e' });
  await expect(page.getByLabel('Default preset')).toHaveValue(/\d+/);
  await page.goto('/kiosk');
  await expect(page).toHaveURL(/preset=noc-e2e/);
  await expect(page.getByText('NOC e2e')).toBeVisible();

  // a key for a screen without a login
  await page.goto('/settings?tab=kiosk');
  await page.getByRole('button', { name: 'Keys NOC e2e' }).click();
  const keys = page.getByRole('dialog', { name: /Kiosk keys: NOC e2e/ });
  await keys.getByLabel('Name of the new key').fill('Lobby TV');
  await keys.getByRole('button', { name: 'New key' }).click();
  const key = (await keys.locator('code').first().textContent())?.trim() ?? '';
  expect(key).toMatch(/^pwk_[A-Za-z0-9_-]{30,}$/);

  const tv = await browser.newContext();
  const screen = await tv.newPage();
  const sessionCalls: string[] = [];
  screen.on('request', (r) => { if (/\/api\/(stream|monitors|kiosk\/presets)\b/.test(r.url())) sessionCalls.push(r.url()); });
  await screen.goto(`/kiosk?preset=noc-e2e#key=${key}`);
  await expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(screen.getByText('Core router')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Exit' })).toHaveCount(0); // nothing leads into the app
  expect(sessionCalls).toEqual([]); // only the key endpoints are used

  await keys.getByRole('button', { name: 'Done, hide key' }).click();
  await expect(keys.locator('code').filter({ hasText: key })).toHaveCount(0); // shown once, then gone
  await keys.getByRole('button', { name: 'Revoke key Lobby TV' }).click();
  await page.getByRole('dialog', { name: 'Revoke key' }).getByRole('button', { name: 'Revoke key' }).click();
  await expect(keys.getByText('Lobby TV')).toHaveCount(0);
  await screen.reload();
  await expect(screen.getByText(/invalid or was revoked/)).toBeVisible();
  await tv.close();

  // leave /kiosk as the other tests expect it
  await keys.getByRole('button', { name: 'Close' }).first().click();
  await page.getByLabel('Default preset').selectOption('');
  await expect(page.getByLabel('Default preset')).toHaveValue('');
});
