import { expect, test } from '@playwright/test';

// #530 demo parity: the real shell on fixtures, the persistent marker, working legacy deep links,
// zero API traffic, and no demo fixtures in a real admin route.
test('@smoke demo runs the real shell on sample data with no API traffic', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
  });

  await page.goto('/demo');
  await expect(page.getByRole('note', { name: 'Demo mode' })).toBeVisible();
  await expect(page.getByText('Simulated demo · sample data')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

  await page.goto('/demo#profiles');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Demo mode' })).toBeVisible();

  await page.goto('/demo#approvals');
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Demo mode' })).toBeVisible();

  await page.goto('/demo#live');
  await expect(page.getByText(/live-site walkthrough has been retired/i)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

  expect(api).toEqual([]);
});

test('@smoke a normal admin route does not load the demo', async ({ page }) => {
  await page.goto('/approvals');
  await expect(page.getByRole('note', { name: 'Demo mode' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
