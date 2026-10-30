import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

test('create an alert, send a test and see the empty history (#76)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/insights/alerts');
  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  await expect(page.getByText('No alert rules yet')).toBeVisible();

  await page.getByRole('button', { name: 'New alert' }).click();
  const drawer = page.getByRole('dialog', { name: 'New alert rule' });
  await drawer.getByRole('textbox', { name: 'Name' }).fill('Bounce watch');
  await expect(drawer).toContainText('Watches bounce or spam-complaint rate over a window.');
  await drawer.getByRole('checkbox', { name: /Alex Morgan/ }).check();
  await drawer.getByRole('button', { name: 'Create rule' }).click();

  await expect(page.getByText('Bounce watch')).toBeVisible();
  await expect(page.getByText(/Bounce rate above 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Send a test' }).click();
  await expect(page.getByText(/Test notification sent to 1 channel/)).toBeVisible();
  await expect(page.getByText('Nothing has fired yet')).toBeVisible();

  const rules = await call<{ rules: { id: string; name: string }[] }>(page.request, 'alerts.list', {});
  for (const rule of rules.rules.filter((r) => r.name === 'Bounce watch')) await call(page.request, 'alerts.delete', { id: rule.id });
});
