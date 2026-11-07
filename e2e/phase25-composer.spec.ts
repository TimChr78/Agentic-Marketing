import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';
import { primePage, settle } from './matrix.mjs';

// Phase 25, #497: the broadcast composer. The seeded "Signal #42 resend to engaged readers" is an
// in-review broadcast with a published template and no run, so its Content tab is the composer. The
// seed's provider is the log adapter and its sending domain has no DKIM selectors, which exercises
// the evidence rows without pretending anything is ready.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SCENARIO = 'Signal #42 resend to engaged readers';

async function broadcastId(page: Page) {
  const list = await call<{ artifacts: { id: string; name: string; type: string }[] }>(page.request, 'artifacts.list', {
    type: 'broadcast',
    limit: 50,
  });
  const broadcast = list.artifacts.find((artifact) => artifact.name === SCENARIO) ?? list.artifacts[0];
  expect(broadcast, 'the seed has a broadcast').toBeTruthy();
  return broadcast.id;
}

async function openComposer(page: Page, id?: string) {
  const broadcast = id ?? (await broadcastId(page));
  await page.goto(`/marketing/broadcasts/${broadcast}`);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live preview' })).toBeVisible();
  return broadcast;
}

test('the composer separates evidence from consent and holds the estimate behind a save', { tag: '@smoke' }, async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  const broadcast = await broadcastId(page);
  const previewRequests: string[] = [];
  const saves: { content?: { segment?: string } }[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/broadcasts.preview')) previewRequests.push(request.url());
    if (request.url().includes('/v1/artifacts.updateDraft')) saves.push(request.postDataJSON());
  });

  await openComposer(page, broadcast);

  // The step links and all three sections are present at once.
  for (const name of ['1 What', '2 Who', '3 When', 'Jump to preview']) {
    await expect(page.getByRole('link', { name })).toBeVisible();
  }
  for (const name of ['1 · What', '2 · Who', '3 · When']) {
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  await expect(page.locator('#composer-what').getByText('Marketing e-mail · consent', { exact: true })).toBeVisible();

  // The outer label is the saved broadcast; the nested label is the exact live template.
  await expect(page.locator('[data-preview-source]').first()).toContainText(/Saved v\d+/);
  await expect(page.locator('[data-preview-source="published"]').first()).toContainText(/Published v\d+/);
  await expect(page.locator('[data-preview-source="published"]').first()).toContainText('template');

  // Evidence rows: the pointer is live; the log adapter is not external delivery; empty DKIM is
  // never proof; the purpose is configured and says nothing about per-person consent.
  await expect(page.locator('[data-check="template"]')).toHaveAttribute('data-check-status', 'ready');
  await expect(page.locator('[data-check="template"]')).toContainText(/Live v\d+/);
  await expect(page.locator('[data-check="provider"]')).toHaveAttribute('data-check-status', 'attention');
  await expect(page.locator('[data-check="provider"]')).toContainText('Log adapter — no external delivery');
  await expect(page.locator('[data-check="domain"]')).not.toHaveAttribute('data-check-status', 'ready');
  await expect(page.locator('[data-check="domain"]')).toContainText('DKIM not checked — selectors required');
  await expect(page.locator('[data-check="consent"]')).toHaveAttribute('data-check-status', 'ready');
  await expect(page.locator('[data-check="consent"]')).toContainText('Purpose configured · Marketing e-mail · consent');
  await expect(page.locator('[data-check="consent"]')).toContainText(
    'Per-person consent, topic preferences and suppression are checked at send time.',
  );
  await expect(page.getByText('Audience consented')).toHaveCount(0);

  // A clean composer ran the one expensive check and shows the check's own wording.
  await expect(page.locator('[data-audience-state="current"]')).toContainText(
    /(?:eligible in current check|No eligible recipients in this check|No members checked)/,
  );
  await expect(page.locator('[data-audience-state="current"]')).toContainText(/as of/);
  expect(previewRequests.length).toBeGreaterThan(0);

  // The seeded send is in the past, and the schedule is in the workspace zone.
  await expect(page.getByText(/This time is in the past/)).toBeVisible();
  await expect(page.locator('#composer-when').getByText('Scheduled time shown in UTC; arrival time varies.')).toBeVisible();

  // Dirtying the segment requires a save before the estimate refreshes.
  const segment = page.getByRole('combobox', { name: 'Segment', exact: true });
  const selected = await segment.inputValue();
  const next = await segment
    .locator('option')
    .evaluateAll(
      (options, current) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value && value !== current),
      selected,
    );
  expect(next, 'the seed has another segment').toBeTruthy();
  const beforeEdit = previewRequests.length;
  await segment.selectOption(next as string);
  await expect(page.getByText('Save draft to refresh the audience estimate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh estimate' })).toBeDisabled();
  await expect(page.locator('[data-preview-source="unsaved"]')).toContainText('Unsaved draft');
  await page.waitForTimeout(400);
  expect(previewRequests.length).toBe(beforeEdit);

  // A successful save makes a new saved version and re-runs the check exactly then.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => saves.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(saves[0].content?.segment).toBe(next);
  await expect(page.locator('[data-preview-source="unsaved"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('[data-preview-source="saved"]').first()).toContainText(/Saved v\d+/);
  await expect.poll(() => previewRequests.length, { timeout: 20_000 }).toBeGreaterThan(beforeEdit);
  await expect(page.getByText('Save draft to refresh the audience estimate')).toHaveCount(0);
});

test('the composer keeps schedule, window and advanced fields without saving them', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  await openComposer(page);

  // On publication removes the stored instant and says so.
  await page.getByRole('radio', { name: 'On publication' }).click();
  await expect(page.getByText('On publication').first()).toBeVisible();

  // Schedule restores a picker in the workspace zone and the preview names the instant.
  await page.getByRole('radio', { name: 'Schedule' }).click();
  const sendAt = page.getByLabel('Send at', { exact: true });
  await sendAt.fill('2026-12-01T09:00');
  await expect(page.getByText(/Dec 1, 2026/).first()).toBeVisible();

  // A local-time window toggles its complete panel and the reader-zone helper.
  const windowToggle = page.getByRole('checkbox', { name: 'Only send inside a local-time window', exact: true });
  await windowToggle.check();
  await expect(page.getByLabel('Window opens', { exact: true })).toHaveValue('09:00');
  await expect(page.getByLabel('Window closes', { exact: true })).toHaveValue('17:00');
  await expect(page.getByText('Readers without a valid zone use the delivery-policy zone.', { exact: true })).toBeVisible();
  await expect(page.getByText(/09:00–17:00 in each reader’s time zone · every day · maximum wait 1 day/)).toBeVisible();

  // Subject test and staged send stay mutually exclusive with a visible reason.
  await page.getByText('Subject test · Off').click();
  await page.getByRole('checkbox', { name: 'Test subject lines on a sample', exact: true }).check();
  await expect(page.getByLabel('Subject A', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Subject B', { exact: true })).toBeVisible();
  await expect(page.getByText('Staged send is unavailable while a subject test is on.')).toBeVisible();

  // Newsletter archive keeps its own fields when enabled.
  await page.getByText(/Newsletter archive · Off/).click();
  await page.getByRole('checkbox', { name: 'Publish to the archive', exact: true }).check();
  await expect(page.getByLabel('Issue address', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Summary', { exact: true })).toBeVisible();
});

test('a reader without artifacts:write sees the composer but cannot edit it', async ({ page }) => {
  await signIn(page, PEOPLE.viewer);
  await openComposer(page);

  await expect(page.getByText('Your role can read this broadcast but cannot edit it.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Template', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Segment', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh checks' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Live preview' })).toBeVisible();
});

test('the composer has no accessibility violations and is captured at 1440 and 390', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  const broadcast = await broadcastId(page);

  for (const view of [
    { theme: 'light' as const, width: 1440 as const },
    { theme: 'dark' as const, width: 1440 as const },
    { theme: 'light' as const, width: 390 as const },
  ]) {
    await primePage(page, { theme: view.theme, width: view.width });
    await openComposer(page, broadcast);
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(horizontal, `${view.width} px ${view.theme} must not scroll sideways`).toBe(false);

    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).options({ iframes: false }).exclude('iframe').analyze();
    const details = violations.map((violation) => `${violation.id}: ${violation.help}`);
    expect(details, `${view.width} px ${view.theme}`).toEqual([]);
    // A full-page capture can otherwise catch the sandboxed e-mail frame before its srcDoc paints.
    await page.waitForTimeout(500);
    // Written to the test's output directory (test-results/), not into the checkout.
    await page.screenshot({ path: test.info().outputPath(`composer-${view.width}-${view.theme}.png`), fullPage: true });
  }
});
