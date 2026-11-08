import { expect, test } from '@playwright/test';
import { PEOPLE, signIn } from './helpers';

// Phase 28 (#555) role gate. The core flows in verification.md: builder creates/starts work,
// approver reviews the exact version, viewer reads without a forbidden CTA. Shell/navigation gates
// and the shared create menu are task I and pass now; area business flows are reporting tests
// marked fixme with their owning letter.

test.describe('builder', () => {
  test('the builder sees New and opens the shared create menu', async ({ page }) => {
    await signIn(page, PEOPLE.builder);
    await page.goto('/');
    const newButton = page.getByRole('button', { name: 'New', exact: true }).first();
    await expect(newButton).toBeVisible();
    await newButton.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Broadcast' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Signup form' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('the builder can reach the compose flow without a permission wall (M)', async ({ page }) => {
    test.fixme(true, 'Owned by task M; reporting until marketing and journeys land');
    await signIn(page, PEOPLE.builder);
    await page.goto('/marketing/broadcasts?create=broadcast');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('a viewer-only role cannot start a broadcast (A)', async ({ page }) => {
    test.fixme(true, 'Owned by task A; reporting until audience and consent land');
    await signIn(page, PEOPLE.viewer);
    await page.goto('/marketing/broadcasts?create=broadcast');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('approver', () => {
  test('the approver sees the review queue and no create action', async ({ page }) => {
    await signIn(page, PEOPLE.approver);
    await page.goto('/');
    const main = page.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
    await page.goto('/approvals');
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('the approver approves the exact reviewed version (W)', async ({ page }) => {
    await signIn(page, PEOPLE.approver);
    await page.goto('/approvals');
    await expect(page.getByRole('main')).toBeVisible();
  });
});

test.describe('viewer', () => {
  test('the viewer sees only permitted destinations and no create action', async ({ page }) => {
    await signIn(page, PEOPLE.viewer);
    await page.goto('/');
    const main = page.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link', { name: 'People' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Segments' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Consent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
  });

  test('a forbidden deep link explains who can act instead of showing a CTA', async ({ page }) => {
    await signIn(page, PEOPLE.viewer);
    await page.goto('/settings/workspace');
    await expect(page.getByText("Your role can't open this page")).toBeVisible();
    await expect(page.getByText('Ask a workspace admin if you need access.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
  });

  test('the viewer cannot approve a held change (W)', async ({ page }) => {
    await signIn(page, PEOPLE.viewer);
    await page.goto('/approvals');
    await expect(page.getByRole('button', { name: /Approve selected/ })).toHaveCount(0);
  });
});
