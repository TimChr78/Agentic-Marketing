import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

// Phase 14, #57: experiences and purposes get named fields instead of the JSON editor.

test('create an experience with two variants in the editor and save', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  await page.goto('/marketing/experiences');
  await page.getByRole('button', { name: 'New experience' }).first().click();
  const create = page.getByRole('dialog', { name: 'New experience' });
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E article banner');
  await create.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/marketing\/experiences\/exp_/);
  const id = page.url().split('/').pop()!;

  await page.getByRole('textbox', { name: 'Placement', exact: true }).fill('e2e-article-footer');
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('A two-variant banner for the e2e suite.');
  await page.getByRole('button', { name: 'Add variant' }).click();

  await expect(page.getByRole('textbox', { name: 'Name of variant 1', exact: true })).toHaveValue('Variant A');
  await page.getByRole('textbox', { name: 'Name of variant 2', exact: true }).fill('Variant B');
  await page.getByRole('textbox', { name: 'Weight of variant 2', exact: true }).fill('60');
  await page.getByRole('textbox', { name: 'HTML for variant 2', exact: true }).fill('<p>Second pitch for the e2e.</p>');
  await expect(page.getByText('The weights total 110%')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name of variant 2', exact: true })).toHaveValue('Variant B');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();

  const saved = await call(page.request, 'artifacts.get', { artifactId: id });
  expect(saved.version.content.placement).toBe('e2e-article-footer');
  expect(saved.version.content.variants).toHaveLength(2);
  expect(saved.version.content.variants[0]).toMatchObject({ id: 'a', name: 'Variant A' });
  expect(saved.version.content.variants[1]).toMatchObject({
    id: 'b',
    name: 'Variant B',
    weight: 60,
    content: { html: '<p>Second pitch for the e2e.</p>' },
  });
});

test('edit a purpose description and save, without renaming its key', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  const list = await call<{ artifacts: { id: string }[] }>(page.request, 'artifacts.list', { type: 'purposes' });
  const artifactId = list.artifacts[0].id;
  const before = await call<{ version: { content: { purposes: { key: string }[] } } }>(page.request, 'artifacts.get', { artifactId });
  const n = before.version.content.purposes.findIndex((p) => p.key === 'marketing_email') + 1;
  await page.goto(`/artifacts/${artifactId}`);

  // marketing_email is in force, so its key is locked and only the description changes.
  await expect(page.getByRole('textbox', { name: `Key of purpose ${n}`, exact: true })).not.toBeEditable();
  await expect(page.getByRole('textbox', { name: `Description of purpose ${n}`, exact: true })).toHaveValue('News and offers by e-mail.');
  await page
    .getByRole('textbox', { name: `Description of purpose ${n}`, exact: true })
    .fill('Weekly news and occasional offers, by e-mail.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/Saved as draft v|Draft saved\./)).toBeVisible();

  const saved = await call<{ version: { content: { purposes: { key: string; description: string }[] } } }>(page.request, 'artifacts.get', {
    artifactId,
  });
  expect(saved.version.content.purposes.find((p) => p.key === 'marketing_email')).toMatchObject({
    key: 'marketing_email',
    description: 'Weekly news and occasional offers, by e-mail.',
  });
});
