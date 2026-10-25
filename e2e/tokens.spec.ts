import { expect, test } from '@playwright/test';
import { PASSWORD, PEOPLE, signIn } from './helpers';

test('narrow a token at once; widening needs the password and says what it allows (#44)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'n8n reporting' }).click();
  await expect(page).toHaveURL(/\/settings\/integrations\/tokens\/tok_/);
  const drawer = page.getByRole('dialog', { name: 'n8n reporting' });
  await expect(drawer).toContainText('Sam Rivera');

  // Widen: add Draft and edit.
  await drawer.getByLabel(/Draft and edit/).check();
  await expect(drawer).toContainText('This widens what the token can do');
  await expect(drawer).toContainText('it could create and edit drafts');
  await drawer.getByRole('button', { name: 'Confirm and widen' }).click();
  await expect(drawer).toContainText('Enter your password');
  await drawer.getByLabel('Your password').fill('wrong-password');
  await drawer.getByRole('button', { name: 'Confirm and widen' }).click();
  await expect(drawer).toContainText('The password is not correct');
  await drawer.getByLabel('Your password').fill(PASSWORD);
  await drawer.getByRole('button', { name: 'Confirm and widen' }).click();
  await expect(page.getByText(/Widened “n8n reporting”/)).toBeVisible();

  // Narrow: remove it again, no password.
  await drawer.getByLabel(/Draft and edit/).uncheck();
  await expect(drawer).toContainText('Applies at once');
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Narrowed “n8n reporting”/)).toBeVisible();

  await expect(drawer.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(drawer).toContainText('Added artifacts:write');
  await expect(drawer).toContainText('confirmed with password');
  await expect(drawer).toContainText('Removed artifacts:write');
});
