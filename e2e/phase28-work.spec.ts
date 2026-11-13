import { expect, type Page, test } from '@playwright/test';
import { BASE, PEOPLE, signIn } from './helpers';
import { loadFixtureIds, primePage, settle } from './matrix.mjs';

// Phase 28 (#556) W acceptance: Home's empty blocks name the next action, the agent Pause and the
// approval footer stay usable at 390 px in both themes, and the stale review keeps its exact-version
// warning. Grouping and role gates are covered by the existing unit and role specs, which stay green.

async function emptyHome(page: Page) {
  const empty = async (pattern: string, visit: (json: Record<string, unknown>) => void) => {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      visit(json);
      await route.fulfill({ response, json });
    });
  };
  await empty('**/v1/agents.list*', (json) => {
    json.agents = [];
  });
  await empty('**/v1/broadcasts.list*', (json) => {
    json.broadcasts = [];
    json.total = 0;
  });
  await empty('**/v1/approvals.list*', (json) => {
    json.approvals = [];
    json.total = 0;
    json.nextCursor = null;
  });
  await empty('**/v1/alerts.list*', (json) => {
    json.rules = [];
  });
  await empty('**/v1/agents.runFailures*', (json) => {
    json.runs = [];
    json.nextCursor = null;
  });
  await empty('**/v1/artifacts.list*', (json) => {
    json.artifacts = [];
    json.nextCursor = null;
  });
}

async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      let parent = el.parentElement;
      let local = false;
      while (parent && parent !== document.body) {
        const ps = getComputedStyle(parent);
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') {
          local = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!local && rect.right > client + 1) {
        offenders.push(`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}`);
        if (offenders.length === 5) break;
      }
    }
    return { scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), client, offenders };
  });
}

test('Home empty blocks name the next action in every block', async ({ page }) => {
  await primePage(page, { theme: 'light', width: 1440 });
  await emptyHome(page);
  await signIn(page, PEOPLE.owner);
  await page.goto('/');
  await settle(page);

  const main = page.getByRole('main');
  for (const text of [
    'No scheduled or sending broadcasts in this sample.',
    'No live journeys in this sample.',
    'No active agents in this sample.',
    'No firing alerts.',
    'No guardian caps.',
    'No failed hosted runs in the last 7 days.',
  ]) {
    await expect(main.getByText(text)).toBeVisible();
  }
  // The pending and hold blocks both report the loaded sample as empty.
  await expect(main.getByText('No pending requests in this sample.').first()).toBeVisible();
  for (const name of [
    'View broadcasts to check their status',
    'View journeys to check their status',
    'View agents to check their status',
    'View alerts to check the rules',
    'View agents to review their limits',
    'View agents to check their runs',
  ]) {
    await expect(main.getByRole('link', { name })).toBeVisible();
  }
  await expect(main.getByRole('link', { name: 'View Approvals' }).first()).toBeVisible();
});

test('the W screens do not overflow the page at 390 px in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await primePage(page, { theme, width: 390 });
    await signIn(page, PEOPLE.owner);
    for (const route of ['/', '/approvals', '/work/agents']) {
      await page.goto(route);
      await settle(page);
      await expect(page.locator('main#main')).toBeVisible();
      const { scroll, client, offenders } = await pageOverflow(page);
      expect(client).toBe(390);
      expect(scroll, `${theme} ${route}: page scroll width ${scroll} > client ${client} + 1`).toBeLessThanOrEqual(client + 1);
      expect(offenders, `${theme} ${route}: elements past the viewport: ${offenders.join(', ')}`).toEqual([]);
    }
  }
});

test('the agent Pause control is reachable and unobstructed at 390 px', async ({ page }) => {
  await primePage(page, { theme: 'light', width: 390 });
  await signIn(page, PEOPLE.owner);
  await page.goto('/work/agents');
  await settle(page);

  const pause = page.getByRole('button', { name: 'Pause' }).first();
  await expect(pause).toBeVisible();
  const box = await pause.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const hit = await pause.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, 'another element covers the Pause control').toBe(true);
});

test('the approval footer is reachable and unobstructed at 390 px', async ({ page }) => {
  await primePage(page, { theme: 'light', width: 390 });
  await signIn(page, PEOPLE.approver);
  await page.goto('/approvals');
  await settle(page);
  await page.locator('[data-approval-link]').first().click();

  const approve = page.getByRole('button', { name: 'Approve and publish' });
  await expect(approve).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
  const box = await approve.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const hit = await approve.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, 'another element covers the approve control').toBe(true);
});

test('a stale review still warns and approves the version on screen', async ({ page }) => {
  await primePage(page, { theme: 'light', width: 1440 });
  await signIn(page, PEOPLE.approver);
  const ids = await loadFixtureIds(async (name: string, input: unknown) => {
    const response = await page.request.post(`/v1/${name}`, { data: input, headers: { origin: BASE } });
    return response.json();
  });
  const id = ids.approvals.broadcast ?? ids.approvals.email;
  expect(id).toBeTruthy();

  await page.route('**/v1/approvals.get*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.artifactLatestVersion = json.version + 1;
    await route.fulfill({ response, json });
  });
  await page.goto(`/approvals/${id}`);
  await settle(page);

  await expect(page.getByText(/A newer draft \(v\d+\) exists/)).toBeVisible();
  await expect(page.getByText(/Approving publishes v\d+, the one shown here/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and publish' })).toBeVisible();
});
