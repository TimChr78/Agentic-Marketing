import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

// Phase 14, #57: experiences and purposes get named fields instead of the JSON editor.

test('create an experience with two variants in the editor and save', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  await page.goto('/build/experiences');
  await page.getByRole('button', { name: 'New experience' }).first().click();
  const create = page.getByRole('dialog', { name: 'New experience' });
  await create.getByLabel('Name').fill('E2E article banner');
  await create.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/build\/experiences\/exp_/);
  const id = page.url().split('/').pop()!;

  await page.getByLabel('Placement').fill('e2e-article-footer');
  await page.getByLabel('Description').fill('A two-variant banner for the e2e suite.');
  await page.getByRole('button', { name: 'Add variant' }).click();

  await expect(page.getByLabel('Name of variant 1')).toHaveValue('Variant A');
  await page.getByLabel('Name of variant 2').fill('Variant B');
  await page.getByLabel('Weight of variant 2').fill('60');
  await page.getByLabel('HTML for variant 2').fill('<p>Second pitch for the e2e.</p>');
  await expect(page.getByText('The weights total 110%')).toBeVisible();
  await expect(page.getByLabel('Name of variant 2')).toHaveValue('Variant B');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();

  const saved = await call(page.request, 'artifacts.get', { artifactId: id });
  expect(saved.version.content.placement).toBe('e2e-article-footer');
  expect(saved.version.content.variants).toHaveLength(2);
  expect(saved.version.content.variants[0]).toMatchObject({ id: 'a', name: 'Variant A' });
  expect(saved.version.content.variants[1]).toMatchObject({ id: 'b', name: 'Variant B', weight: 60, content: { html: '<p>Second pitch for the e2e.</p>' } });
});

test('edit a purpose description and save, without renaming its key', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  const created = await call(page.request, 'artifacts.create', {
    type: 'purposes',
    name: 'Purposes',
    content: {
      purposes: [
        {
          key: 'marketing_email',
          name: 'Marketing e-mail',
          description: 'News and offers by e-mail.',
          basis: 'consent',
          channels: ['email'],
          requiresDoubleOptIn: false,
        },
      ],
    },
  });
  await page.goto(`/artifacts/${created.artifactId}`);

  // marketing_email is in force, so its key is locked and only the description changes.
  await expect(page.getByLabel('Key of purpose 1')).not.toBeEditable();
  await expect(page.getByLabel('Description of purpose 1')).toHaveValue('News and offers by e-mail.');
  await page.getByLabel('Description of purpose 1').fill('Weekly news and occasional offers, by e-mail.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();

  const saved = await call(page.request, 'artifacts.get', { artifactId: created.artifactId });
  expect(saved.version.content.purposes[0]).toMatchObject({
    key: 'marketing_email',
    description: 'Weekly news and occasional offers, by e-mail.',
  });
});
