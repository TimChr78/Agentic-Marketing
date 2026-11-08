import { expect, type Page, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';
import { settle } from './matrix.mjs';

// Phase 28 (#557) area M: marketing and journey polish. The specs cover the audit's M1 remedy and
// the area acceptance criteria: name-only purpose selection, broadcast actions at 390, a readable
// journey summary without zoom, and no animated chart or canvas layout.

type ArtifactRow = { id: string; name: string };

async function artifactId(page: Page, type: string, preferred?: string): Promise<string> {
  const list = await call<{ artifacts: ArtifactRow[] }>(page.request, 'artifacts.list', { type });
  const match = preferred ? list.artifacts.find((row) => row.name === preferred) : undefined;
  const id = (match ?? list.artifacts[0])?.id;
  expect(id, `a seeded ${type}`).toBeTruthy();
  return id!;
}

async function openJourney(page: Page) {
  await signIn(page, PEOPLE.builder);
  const id = await artifactId(page, 'journey', 'Welcome series');
  await page.goto(`/marketing/journeys/${id}`);
  await settle(page);
  return id;
}

test('the journey purpose selector shows friendly names without technical keys', async ({ page }) => {
  await openJourney(page);
  const select = page.getByRole('combobox', { name: 'Purpose' });
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('marketing_email');
  const labels = await select.locator('option').allTextContents();
  expect(labels).toContain('Marketing e-mail');
  expect(labels.some((label) => label.includes('marketing_email'))).toBe(false);
});

test.describe('390 px marketing surfaces', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('broadcast primary and overflow actions stay reachable', async ({ page }) => {
    await signIn(page, PEOPLE.builder);
    const id = await artifactId(page, 'broadcast', 'Signal #42 resend to engaged readers');
    await page.goto(`/marketing/broadcasts/${id}`);
    await settle(page);

    // The one primary action follows the broadcast's state, which earlier specs change (the
    // composer saves a new draft), so accept each label ArtifactDetailPage can choose.
    const PRIMARY = /^(Review the request|View request|View the approval request|Submit for review|Publish( v\d+)?|Save draft)$/;
    const main = page.locator('main#main');
    const primary = main
      .getByRole('link', { name: PRIMARY })
      .or(main.getByRole('button', { name: PRIMARY }))
      .first();
    await expect(primary).toBeVisible();
    const more = page.getByRole('button', { name: 'More actions' });
    await expect(more).toBeVisible();

    for (const action of [primary, more]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    }
  });

  test('the journey summary is readable without zooming the canvas', async ({ page }) => {
    await openJourney(page);
    const summary = page.getByRole('region', { name: 'Journey steps' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Confirmed subscription');
    const step = summary.getByText('Welcome e-mail').first();
    await expect(step).toBeVisible();
    const fontSize = await step.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(12);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
  });
});

test('the sending panel reserves its KPI region while status loads', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  const id = await artifactId(page, 'broadcast', 'Signal #40: the inbox metric that matters');
  await page.route('**/v1/broadcasts.status*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto(`/marketing/broadcasts/${id}?tab=sending`);
  const region = page.getByRole('status', { name: 'Loading sending status' });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('aria-busy', 'true');
  await expect(region).toHaveAttribute('data-geometry', 'kpi');
  await expect(region).toHaveAttribute('data-skeleton-visible', 'true', { timeout: 2_000 });
  await expect(region).toHaveCount(0, { timeout: 10_000 });
});

test('the canvas fit and report charts do not animate', async ({ page }) => {
  const id = await openJourney(page);

  await page.getByRole('button', { name: 'Auto-layout' }).click();
  await page.waitForTimeout(50);
  const settled = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.waitForTimeout(250);
  // With a timed fit the viewport transform would still be moving after 50 ms.
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', settled ?? '');
  const running = await page.locator('.react-flow').evaluate((el) => {
    const animations = (el as HTMLElement).getAnimations({ subtree: true });
    return animations.filter((animation) => animation.playState === 'running').length;
  });
  expect(running).toBe(0);
  const infinite = await page
    .locator('.react-flow')
    .evaluate(
      (el) => Array.from(el.querySelectorAll('*')).filter((node) => getComputedStyle(node).animationIterationCount === 'infinite').length,
    );
  expect(infinite).toBe(0);

  await page.goto(`/marketing/journeys/${id}?tab=report`);
  await settle(page);
  await expect(page.getByText('Current participants')).toBeVisible();
  await page.waitForTimeout(400);
  const chartAnimation = await page.locator('main#main').evaluate((el) => {
    const animations = (el as HTMLElement).getAnimations({ subtree: true });
    return animations.filter((animation) => animation.playState === 'running').length;
  });
  expect(chartAnimation).toBe(0);
});
