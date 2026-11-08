import { expect, type Page, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';
import { primePage, settle } from './matrix.mjs';

// Phase 28 (#558) audience and consent acceptance. At 390 px the consent counts and the next
// action are visible, purpose names replace technical keys in ordinary labels and toasts, and the
// lookup and consent permission boundaries still hold.

/** The seeded reader the lookup tests open. */
const READER = 'reader1@example.net';

function purposesTable(page: Page) {
  return page.getByRole('table', { name: 'Purposes' });
}

async function expectInViewport(locator: ReturnType<Page['locator']>) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, 'element has a box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
}

test.describe('consent at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('names purposes and keeps counts, double opt-in and the lookup action in view', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/audience/consent');
    await settle(page);

    const table = purposesTable(page);
    await expect(table).toBeVisible();
    // Names only: no technical purpose key sits in an ordinary label.
    await expect(table.getByText('Personalization', { exact: true })).toBeVisible();
    await expect(table.getByText('Marketing e-mail', { exact: true })).toBeVisible();
    await expect(table).not.toContainText('web_personalization');
    await expect(table).not.toContainText(/\(marketing_email\)/);
    expect(await table.locator('code').count()).toBe(0);

    // The row stacks at phone width, so its count and double opt-in need no local panning.
    const row = table.locator('tr', { hasText: 'Marketing e-mail' });
    await expectInViewport(row.getByText(/\d+ allowed/).first());
    await expectInViewport(row.getByText(/^Double opt-in:/));
    await expect(row).toContainText(/Double opt-in:\s*(?:Yes|No)/);

    // The next action on the screen is reachable without horizontal scrolling.
    await expectInViewport(page.getByRole('button', { name: 'Look up', exact: true }));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'page-level horizontal overflow in CSS px').toBeLessThanOrEqual(1);
  });

  test('records consent with the purpose name in the toast, never its key', async ({ page }) => {
    // Fulfil the append locally so the seeded counts and visual baselines do not move.
    await page.route('**/v1/consent.record', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recorded: true, allowed: true }) }),
    );
    await signIn(page, PEOPLE.owner);
    await page.goto('/audience/consent');
    await settle(page);

    await page.getByLabel('E-mail or profile id', { exact: true }).fill(READER);
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    const ledger = page.getByRole('table', { name: 'Consent ledger' });
    await expect(ledger).toBeVisible();

    await page.getByRole('button', { name: 'Record consent', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Record consent' });
    await drawer.getByRole('combobox', { name: 'Purpose', exact: true }).selectOption({ label: 'Marketing e-mail' });
    await drawer.getByRole('button', { name: 'Record consent', exact: true }).click();

    const toast = page.getByRole('status').filter({ hasText: 'Recorded “Marketing e-mail” as Granted' });
    await expect(toast).toBeVisible();
    await expect(toast).not.toContainText('marketing_email');
    await expect(page.getByText(/Recorded “marketing_email”/)).toHaveCount(0);
  });

  test('dark mode keeps the purpose names and counts readable at 390', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await primePage(page, { theme: 'dark', width: 390 });
    await page.goto('/audience/consent');
    await settle(page);

    const table = purposesTable(page);
    await expect(table.getByText('Personalization', { exact: true })).toBeVisible();
    const row = table.locator('tr', { hasText: 'Marketing e-mail' });
    await expectInViewport(row.getByText(/\d+ allowed/).first());
    await expect(table).not.toContainText('web_personalization');
  });
});

test.describe('consent permission and lookup', () => {
  test('the viewer can read purposes but has no record action and no protected reads', async ({ page }) => {
    const commands: string[] = [];
    page.on('request', (request) => {
      const match = /\/v1\/([a-z]+\.[a-z]+)/.exec(request.url());
      if (match) commands.push(match[1]);
    });
    await signIn(page, PEOPLE.viewer);
    await page.goto('/audience/consent');
    await settle(page);

    // The viewer role holds artifacts:read only, so the consent tab explains who can act.
    await expect(page.getByText("Your role can't open this tab")).toBeVisible();
    await expect(page.getByText(/Ask a workspace admin/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record consent', exact: true })).toHaveCount(0);
    expect(commands.filter((name) => name === 'consent.summary' || name === 'profiles.find' || name === 'consent.record')).toEqual([]);
  });

  test('the lookup opens the seeded person and the person page names purposes', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/audience/people');
    await page.getByRole('textbox', { name: 'E-mail or profile ID', exact: true }).fill(READER);
    await page.getByRole('button', { name: 'Find person', exact: true }).click();
    await expect(page).toHaveURL(/\/audience\/people\/prf_/);
    await expect(page.getByRole('heading', { level: 1, name: READER })).toBeVisible();

    await page.getByRole('tab', { name: 'Consent' }).click();
    const table = page.getByRole('table', { name: 'Consent ledger' });
    const current = page.getByRole('list', { name: 'Current consent per purpose' }).first();
    await expect(current).toBeVisible();
    await expect(current).toContainText('Marketing e-mail');
    await expect(current).not.toContainText('marketing_email');
    if (await table.count()) await expect(table).not.toContainText('marketing_email');
  });
});
