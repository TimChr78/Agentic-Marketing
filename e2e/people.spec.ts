import { expect, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';

// The People lookup is the one screen people use to find a subscriber: type an e-mail, skip the
// profile list and open the person. It is a smoke check because a broken search hides every profile.

test('people lookup finds a seeded person by e-mail', { tag: '@smoke' }, async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/audience/people');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();

  const search = page.getByRole('textbox', { name: 'Search by e-mail or profile id', exact: true });
  await search.fill('reader1@example.net');
  await page.getByRole('button', { name: 'Find', exact: true }).click();

  const table = page.getByRole('table', { name: 'People' });
  await expect(table).toContainText('reader1@example.net');

  await table.getByRole('row').filter({ hasText: 'reader1@example.net' }).getByRole('link').first().click();
  await expect(page).toHaveURL(/\/audience\/people\/prf_/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('reader1@example.net').first()).toBeVisible();
});
