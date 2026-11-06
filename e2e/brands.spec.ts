import { expect, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';

// #190: a person with two brands switches in one click, the choice survives a reload, and an owner
// can create a brand and lands in it. #180: the desktop rail collapses at 1440, survives a reload,
// and the drawer still works at 390.

test('switch brand without a reload and keep it after reloading (#190)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/');
  // The seed's main workspace and its published brand are both named MartechSignal.
  const switcher = page.getByRole('button', { name: /^Brand: MartechSignal/ });
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText('MartechSignal');

  await switcher.click();
  await page.getByRole('menuitem', { name: /Sandbox/ }).click();
  await expect(page.getByRole('button', { name: /^Brand: Sandbox/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: /^Brand: Sandbox/ })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('am.workspace'));
  expect(stored).toBeTruthy();
});

test('an owner creates a brand and lands in it (#190)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/');
  await page.getByRole('button', { name: /^Brand: .*Switch brand/ }).click();
  await page.getByRole('menuitem', { name: 'New brand…' }).click();

  const dialog = page.getByRole('dialog', { name: 'New brand' });
  await expect(dialog).toBeVisible();
  const suffix = Date.now();
  await dialog.getByLabel('Brand name').fill(`E2E brand ${suffix}`);
  await dialog.getByLabel('Primary domain').fill(`e2e-${suffix}.example`);
  await dialog.getByLabel('Site name').fill(`E2E site ${suffix}`);
  await dialog.getByRole('button', { name: 'Create brand' }).click();

  await expect(page.getByRole('button', { name: new RegExp(`^Brand: E2E brand ${suffix}`) })).toBeVisible();
  // The new brand artifact is a draft, so the switcher shows the workspace name and the pending domain.
  await expect(page.getByRole('button', { name: /^Brand: .*Switch brand/ })).toContainText(`e2e-${suffix}.example`);
});

test('the desktop nav collapses to a rail and the mobile drawer is unchanged (#180)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/');

  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar).toBeVisible();
  expect((await sidebar.boundingBox())?.width).toBeGreaterThan(200);

  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64);
  // Every rail icon has an accessible name, and the approvals badge is still visible on Work.
  await expect(page.getByRole('button', { name: /Work navigation, 3 pending/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Marketing navigation' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  expect((await sidebar.boundingBox())?.width).toBe(64);

  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, `no horizontal overflow at ${width}px`).toBe(false);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#app-sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
});
