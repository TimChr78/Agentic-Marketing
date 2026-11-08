import { expect, type Page, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';

// Phase 28 (#555) shared state gate: the reserved skeleton, empty and error patterns. Auth and the
// shared skeleton are task I and pass now; list/detail states are reporting tests for the owning
// area task and are marked fixme with that letter.

async function delaySession(page: Page) {
  await page.route('**/api/auth/get-session**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
}

test.describe('shared states', () => {
  test('the session read reserves the signed-out frame and labels the busy region once', async ({ page }) => {
    await delaySession(page);
    await page.goto('/');
    const region = page.getByRole('status', { name: 'Loading your workspace' });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(region).toHaveAttribute('data-geometry', 'auth');
    // The shapes are reserved immediately and revealed after the 150 ms threshold.
    await expect(region).toHaveAttribute('data-skeleton-visible', 'true', { timeout: 2_000 });
    // Only the one labelled region announces; the tonal shapes are aria-hidden.
    await expect(page.locator('[data-skeleton-region]')).toHaveCount(1);
    const reserved = await region.boundingBox();
    expect(reserved).not.toBeNull();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // The signed-out column keeps its x and width when the real form replaces the reserved slot.
    const form = await page.locator('form').boundingBox();
    expect(form).not.toBeNull();
    expect(Math.abs(reserved!.x - form!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(reserved!.width - form!.width)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-skeleton-region]')).toHaveCount(0);
  });

  test('a failed sign-in keeps the typed address and explains the recovery', async ({ page }) => {
    await page.route('**/api/auth/sign-in/email', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Invalid credentials' }) }),
    );
    await page.goto('/');
    await page.getByLabel('E-mail', { exact: true }).fill('sam@example.com');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Couldn’t sign in. Check your e-mail and password, then try again.');
    await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue('sam@example.com');
    // The raw server exception never reaches ordinary copy.
    await expect(page.getByRole('alert')).not.toContainText('Invalid credentials');
  });

  test('the sign-in button keeps its label and a static progress glyph while busy', async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/auth/sign-in/email', async (route) => {
      await gate;
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/');
    await page.getByLabel('E-mail', { exact: true }).fill('sam@example.com');
    await page.getByLabel('Password', { exact: true }).fill('anything');
    const button = page.getByRole('button', { name: 'Sign in' });
    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toContainText('Sign in');
    const glyph = button.locator('svg');
    await expect(glyph).toHaveCount(1);
    const animation = await glyph.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe('none');
    release();
  });

  test('reduced motion removes transitions, animations and delays', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const theme = page.getByRole('button', { name: /^Theme:/ });
    await theme.hover();
    const styles = await theme.evaluate((el) => {
      const s = getComputedStyle(el);
      return { duration: s.transitionDuration, delay: s.transitionDelay, animation: s.animationName };
    });
    for (const value of styles.duration.split(',')) expect(Number.parseFloat(value)).toBe(0);
    for (const value of styles.delay.split(',')) expect(Number.parseFloat(value)).toBe(0);
    expect(styles.animation).toBe('none');
    const loops = await page.evaluate(
      () => Array.from(document.querySelectorAll('*')).filter((el) => getComputedStyle(el).animationIterationCount === 'infinite').length,
    );
    expect(loops).toBe(0);
  });

  test('an entering overlay stays within the 180 ms ceiling', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Theme:/ }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const style = await menu.evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, duration: s.animationDuration, transition: s.transitionDuration };
    });
    if (style.name !== 'none') expect(Number.parseFloat(style.duration)).toBeLessThanOrEqual(0.18);
    for (const value of style.transition.split(',')) expect(Number.parseFloat(value)).toBeLessThanOrEqual(0.18);
  });

  test('an empty list names the missing object and its next action (W)', async ({ page }) => {
    test.fixme(true, 'Owned by task W; reporting until Home, approvals and agents land');
    await signIn(page, PEOPLE.owner);
    await page.goto('/work/agents?tab=library');
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('a failed list read keeps the heading and offers Retry (S)', async ({ page }) => {
    await page.route('**/v1/analytics.query*', (route) => route.fulfill({ status: 500, body: '{}' }));
    await signIn(page, PEOPLE.owner);
    await page.goto('/insights/analytics');
    await expect(page.getByRole('alert')).toContainText('Retry');
  });

  test('the shared list skeleton matches the ready table geometry (W)', async ({ page }) => {
    test.fixme(true, 'Owned by task W; reporting until Home, approvals and agents land');
    await signIn(page, PEOPLE.owner);
    await page.route('**/v1/approvals.list*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.goto('/approvals');
    await expect(page.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });
});
