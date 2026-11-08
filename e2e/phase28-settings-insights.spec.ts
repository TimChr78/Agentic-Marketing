import { expect, type Page, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';
import { primePage, settle } from './matrix.mjs';

// Phase 28 (#560) S acceptance: the token status stays in the first 390 px view, the strict-input
// guidance states its own limit, a partial provider read names only the failed channels, and the
// reports keep their period, denominator, freshness and accessible tables.

const TOKEN_STATUS = /^(Active|Expired|Revoked)$/;

async function openIntegrations(page: Page, theme: 'light' | 'dark' = 'light') {
  await primePage(page, { theme, width: 390 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/settings/integrations');
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations and API tokens' })).toBeVisible();
}

test('the token status sits beside the name within 390 px in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openIntegrations(page, theme);
    await page.getByRole('tab', { name: 'API tokens' }).click();

    const table = page.getByRole('table', { name: 'API tokens' });
    const status = table.locator('tbody tr').first().getByText(TOKEN_STATUS).first();
    await expect(status).toBeVisible();
    const box = await status.boundingBox();
    expect(box, `${theme}: status has no box`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);

    // The separate Status column is the desktop presentation; it is not clipped at the right edge.
    await expect(table.getByRole('columnheader', { name: 'Status' })).toBeHidden();
  }
});

test('the strict-input guidance states the observation and what it does not guarantee', async ({ page }) => {
  await page.route('**/v1/system.inputWarnings*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clients: [], sinceDays: 30, strictInputs: false, safeToEnableStrict: true }),
    }),
  );
  await openIntegrations(page);

  await expect(page.getByText('No unknown input keys recorded in the last 7 days')).toBeVisible();
  await expect(page.getByText(/Review your clients before enabling strict input validation/)).toBeVisible();
  await expect(page.getByText(/does not guarantee that every client is ready/)).toBeVisible();
  await expect(page.getByText(/safe to set/i)).toHaveCount(0);

  await page.getByText('Technical setup').click();
  await expect(page.getByText('STRICT_INPUTS=true')).toBeVisible();
});

test('a partial provider read names only the failed channels', async ({ page }) => {
  await page.route('**/v1/pushProviders.list*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await primePage(page, { theme: 'dark', width: 390 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/settings/providers');
  await settle(page);

  await expect(page.getByText('Some provider channels couldn’t load')).toBeVisible();
  await expect(page.getByText(/Push could not be read/)).toBeVisible();
  await expect(page.getByText(/The other 3 channels loaded and remain usable/)).toBeVisible();
  await expect(page.getByText('Couldn’t load providers')).toHaveCount(0);
  // The e-mail channel answered, so its provider stays visible and usable.
  await expect(page.getByText(/\d of 4 channels configured/)).toBeVisible();
  await expect(page.getByText('Development log').filter({ visible: true })).toBeVisible();
});

test('Analytics keeps its period, freshness, denominator and accessible data table', async ({ page }) => {
  await primePage(page, { theme: 'light', width: 1440 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/insights/analytics');
  await settle(page);

  await expect(page.getByText(/Latest event in period:/)).toBeVisible();
  await expect(page.getByText(/UTC/).first()).toBeVisible();
  await expect(page.getByText(/clicked \/ .* delivered/).first()).toBeVisible();
  await expect(page.getByRole('table', { name: 'Analytics results' })).toBeVisible();
  await expect(page.getByText(/Daily unique people are not added to period totals/).first()).toBeVisible();
});

test('Deliverability keeps its window, denominator, freshness and accessible table', async ({ page }) => {
  await primePage(page, { theme: 'light', width: 1440 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/insights/deliverability');
  await settle(page);

  await expect(page.getByRole('heading', { name: /Delivery health · rolling \d+ days/ })).toBeVisible();
  await expect(page.getByText(/minimum \d+/).first()).toBeVisible();
  await expect(page.getByText(/Latest event in period: Unavailable/).first()).toBeVisible();
  await expect(page.getByRole('table').first()).toBeVisible();
});

test('a failed report read names the report and offers Retry', async ({ page }) => {
  await page.route('**/v1/analytics.query*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await primePage(page, { theme: 'light', width: 1440 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/insights/analytics');
  await settle(page);

  const alert = page.getByText('Couldn’t load analytics').first();
  await expect(alert).toBeVisible();
  await expect(page.getByRole('alert').getByRole('button', { name: 'Retry' }).first()).toBeVisible();
});
