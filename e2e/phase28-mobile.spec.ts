import { expect, type Page, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';
import { navRoutes, settle } from './matrix.mjs';

// Phase 28 (#555) mobile gate: no page-level horizontal overflow at 390 px on any nav route. The
// shell, auth screens and shared UI are task I and must pass now; area routes start as reporting
// tests and are marked fixme with their owner until that task flips them on.

/** Which task owns the screen content of each nav route (README exact file lists). */
const OWNER: Record<string, 'I' | 'W' | 'M' | 'A' | 'C' | 'S'> = {
  '/': 'W',
  '/approvals': 'W',
  '/work/agents': 'W',
  '/marketing/campaigns': 'M',
  '/marketing/broadcasts': 'M',
  '/marketing/journeys': 'M',
  '/marketing/experiences': 'M',
  '/audience/people': 'A',
  '/audience/segments': 'A',
  '/audience/forms': 'A',
  '/audience/consent': 'A',
  '/content/templates': 'C',
  '/content/assets': 'C',
  '/content/brand': 'C',
  '/insights/analytics': 'S',
  '/insights/messages': 'S',
  '/insights/deliverability': 'S',
  '/insights/alerts': 'S',
  '/settings': 'S',
  '/settings/workspace': 'S',
  '/settings/providers': 'S',
  '/settings/integrations': 'S',
  '/settings/secrets': 'S',
  '/settings/users': 'S',
  '/settings/approval-policy': 'S',
};

async function pageOverflow(page: Page): Promise<{ scroll: number; client: number; body: number; offenders: string[] }> {
  return page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      // Local scroll regions (a data table, a code view) are allowed to be wider than the page.
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
        offenders.push(
          `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''} right=${Math.round(rect.right)}`,
        );
        if (offenders.length === 5) break;
      }
    }
    return {
      scroll: document.documentElement.scrollWidth,
      client,
      body: document.body.scrollWidth,
      offenders,
    };
  });
}

async function expectNoPageOverflow(page: Page) {
  const { scroll, client, body, offenders } = await pageOverflow(page);
  expect(client).toBe(390);
  expect(Math.max(scroll, body), `page scroll width ${Math.max(scroll, body)} > client ${client} + 1`).toBeLessThanOrEqual(client + 1);
  // Clipping content with overflow hidden does not pass: name the elements that stick out instead.
  expect(offenders, `elements past the 390 px viewport: ${offenders.join(', ')}`).toEqual([]);
}

test.describe('390 px page width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const route of navRoutes()) {
    const owner = OWNER[route.path] ?? 'S';
    test(`${route.path} has no page-level horizontal overflow (${owner})`, async ({ page }) => {
      test.fixme(owner !== 'I' && owner !== 'W', `Owned by task ${owner}; reporting until that area lands`);
      await signIn(page, PEOPLE.owner);
      await page.goto(route.path);
      await settle(page);
      await expect(page.locator('main#main')).toBeVisible();
      await expectNoPageOverflow(page);
    });
  }

  test('sign-in has no page-level horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('forgot password has no page-level horizontal overflow', async ({ page }) => {
    await page.goto('/forgot-password');
    await expect(page.getByRole('heading', { name: 'Forgot password' })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('reset password without a token has no page-level horizontal overflow', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('the mobile navigation drawer fits the viewport and does not overflow the page', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expect(drawer).toHaveCount(0);
  });
});
