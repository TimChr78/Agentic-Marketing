import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

test('add, edit, disable and delete an e-mail provider (#40)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/settings/providers');
  await page.getByRole('button', { name: 'Add provider' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Add an e-mail provider' });
  await drawer.getByLabel('Provider').selectOption('postmark');
  await expect(drawer).toContainText('Postmark tracks opens and clicks only when');
  await expect(drawer.getByRole('link', { name: /Docs/ })).toHaveAttribute('href', /postmarkapp\.com/);
  await drawer.getByRole('textbox', { name: 'Name', exact: true }).fill('Postmark (newsletter)');
  await drawer.getByLabel('From address').fill('news@martechsignal.example');
  await drawer.getByRole('checkbox', { name: 'Marketing' }).check();
  await expect(drawer).toContainText('Moves it from “Development log”');
  // Named fields from the adapter schema; a too-short token is refused on its field.
  await drawer.getByLabel('Server token').fill('short');
  await drawer.getByRole('button', { name: 'Add provider' }).click();
  await expect(drawer).toContainText('Credentials for Postmark are not valid');
  await expect(drawer.getByText(/Too small|at least/i)).toBeVisible();
  await drawer.getByLabel('Server token').fill('pm-server-token-0123456789');
  await drawer.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByRole('dialog', { name: /Webhook URL/ })).toContainText('/hooks/email/');
  await page.getByRole('button', { name: "I've saved it" }).click();

  const item = page.getByRole('listitem').filter({ hasText: 'Postmark (newsletter)' });
  await expect(item).toContainText('Sends marketing e-mail');
  await item.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit “Postmark (newsletter)”' });
  await expect(edit.getByLabel('Server token')).toHaveValue('');
  await edit.getByLabel('From name').fill('MartechSignal');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved “Postmark (newsletter)”.')).toBeVisible();

  await item.getByRole('switch').click();
  await expect(item).toContainText('Disabled');

  await item.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'Delete provider' })).toBeDisabled();
  await confirm.getByLabel(/Type/).fill('Postmark (newsletter)');
  await confirm.getByRole('button', { name: 'Delete provider' }).click();
  await expect(page.getByText('Deleted “Postmark (newsletter)”.')).toBeVisible();
  const list = await call(page.request, 'emailProviders.list', {});
  expect((list as { providers: { name: string }[] }).providers.map((p) => p.name)).not.toContain('Postmark (newsletter)');
});
