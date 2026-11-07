import { expect, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';

// The People lookup is the one screen people use to find a subscriber: type an e-mail, skip the
// profile list and open the person. It is a smoke check because a broken search hides every profile.

test('people lookup finds a seeded person by e-mail', { tag: '@smoke' }, async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  await page.goto('/audience/people');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();

  const search = page.getByRole('textbox', { name: 'E-mail or profile ID', exact: true });
  await search.fill('reader1@example.net');
  await page.getByRole('button', { name: 'Find person', exact: true }).click();

  // An exact e-mail opens the person instead of leaving a one-row list.
  await expect(page).toHaveURL(/\/audience\/people\/prf_/);
  await expect(page.getByRole('heading', { level: 1, name: 'reader1@example.net' })).toBeVisible();
});
