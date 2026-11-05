import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

test('create an alert, send a test and see its history (#76)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/insights/alerts');
  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Bounce ceiling' }) })).toBeVisible();

  await page.getByRole('button', { name: 'New alert' }).click();
  const drawer = page.getByRole('dialog', { name: 'New alert rule' });
  await drawer.getByRole('textbox', { name: 'Name' }).fill('Bounce watch');
  await expect(drawer).toContainText('Watches bounce or spam-complaint rate over a window.');
  await drawer.getByRole('checkbox', { name: /Alex Morgan/ }).check();
  await drawer.getByRole('button', { name: 'Create rule' }).click();

  const created = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Bounce watch' }) });
  await expect(created.getByRole('heading', { name: 'Bounce watch' })).toBeVisible();
  await expect(created.getByText('Bounce rate above 5.0% over 24 hours, after at least 100 sent.')).toBeVisible();
  await created.getByRole('button', { name: 'Send a test' }).click();
  await expect(page.getByText('Test notifications: 1 sent, 0 queued, 0 failed.')).toBeVisible();
  // The seeded workspace has history: rules that fired and recovered before this test began.
  await expect(page.getByRole('table', { name: 'Alert history' })).toContainText('Bounce ceiling');

  const rules = await call<{ rules: { id: string; name: string }[] }>(page.request, 'alerts.list', {});
  for (const rule of rules.rules.filter((r) => r.name === 'Bounce watch')) await call(page.request, 'alerts.delete', { id: rule.id });
});
