import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';
import { settle } from './matrix.mjs';

// Phase 25, #499: the e-mail editor's Insert palette, preview modes and provenance labels.
// The seeded Weekly Signal #42 template is published v1 and has no text part, which exercises the
// local draft renderer and the "save draft to generate text" limitation.

async function openTemplate(page: import('@playwright/test').Page) {
  await signIn(page, PEOPLE.builder);
  const list = await call<{ artifacts: { id: string; name: string }[] }>(page.request, 'artifacts.list', { type: 'email_template' });
  const template = list.artifacts.find((a) => a.name === 'Weekly Signal #42') ?? list.artifacts[0];
  expect(template, 'the seed has an e-mail template').toBeTruthy();
  await page.goto(`/content/templates/${template.id}`);
  await settle(page);
  await expect(page.locator('.am-gjs .gjs-editor')).toBeVisible({ timeout: 20_000 });
  return template;
}

test('the editor inserts from the palette, opens every preview mode and labels the source', async ({ page }) => {
  await openTemplate(page);

  // A clean editor preview is the exact saved version, not an unsaved draft.
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('[data-preview-source="saved"]')).toContainText(/Saved v\d+/);
  await expect(page.getByTitle(/^E-mail preview, desktop$/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('radio', { name: 'Visual' }).click();
  await expect(page.locator('.am-gjs .gjs-editor')).toBeVisible();

  // One Insert palette with the six basic elements, searchable, and reusable blocks in a second tab.
  const insert = page.getByRole('button', { name: 'Insert', exact: true });
  await insert.click();
  const palette = page.getByRole('dialog', { name: 'Insert' });
  await expect(palette).toBeVisible();
  for (const label of ['Text', 'Image', 'Button', 'Divider', 'Spacer', 'Columns']) {
    await expect(palette.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await palette.getByLabel('Find an element or block').fill('zzz');
  await expect(palette.getByText(/No elements match/)).toBeVisible();
  await palette.getByLabel('Find an element or block').fill('spacer');
  await expect(palette.getByRole('button', { name: 'Spacer', exact: true })).toBeVisible();
  await expect(palette.getByRole('button', { name: 'Text', exact: true })).toHaveCount(0);
  await palette.getByLabel('Find an element or block').fill('');

  // The reusable-blocks tab shares the block list; a block created by another spec may already
  // exist, so accept either the empty state or the shared list.
  await palette.getByRole('tab', { name: 'Reusable blocks' }).click();
  await expect(
    palette.getByText('No reusable blocks yet. Create one in Design → Blocks').or(palette.locator('ul button').first()),
  ).toBeVisible();

  // Insert a text element into the visual editor; it lands in the first compatible column.
  await palette.getByRole('tab', { name: 'Elements' }).click();
  await palette.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(palette).toBeHidden();
  await expect(insert).toBeFocused();

  await page.getByRole('radio', { name: 'MJML and Liquid' }).click();
  const source = page.getByLabel('MJML with Liquid');
  await expect(source).toHaveValue(/Write your text here\./, { timeout: 15_000 });

  // The draft preview is local, labelled Unsaved draft, and offers width, dark mail and text modes.
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('[data-preview-source="unsaved"]')).toContainText('Unsaved draft');
  await expect(page.locator('[data-preview-source="unsaved"]')).toContainText(/Based on Saved v\d+/);
  await expect(page.getByTitle(/^E-mail preview, desktop$/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('radio', { name: 'Mobile' }).click();
  await expect(page.getByTitle(/^E-mail preview, mobile$/)).toBeVisible();

  await page.getByRole('button', { name: 'Dark mail' }).click();
  await expect(page.getByRole('button', { name: 'Dark mail' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Approximation — mail clients vary.')).toBeVisible();
  await expect(page.getByTitle(/^E-mail preview, mobile, dark mail$/)).toBeVisible();

  await page.getByRole('radio', { name: 'Text version' }).click();
  await expect(page.getByText('Save draft to generate the text version')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Mobile' })).toHaveCount(0);
});

test('the template Preview tab labels the saved version it actually shows', async ({ page }) => {
  await openTemplate(page);
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.locator('[data-preview-source="saved"]')).toContainText(/Saved v\d+/);
  await expect(page.getByTitle(/E-mail preview/)).toBeVisible({ timeout: 20_000 });
});
