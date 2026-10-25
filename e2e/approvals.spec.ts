import { expect, test } from '@playwright/test';
import { call, PASSWORD, PEOPLE, signIn } from './helpers';

test.describe('approvals (#41)', () => {
  test('sign in, review the rendered e-mail, reject needs a reason, approve', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('E-mail').fill(PEOPLE.approver);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Approvers land on the queue; the demo is nowhere in the signed-in app.
    await expect(page).toHaveURL(/\/approvals$/);
    await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText(/demo/i);

    const row = page.getByRole('row', { name: /Weekly Signal #43/ });
    await expect(row).toContainText('Hermes');
    await expect(row).toContainText('token of Sam Rivera');
    await expect(row).toContainText('Not yet viewed');
    await expect(row.getByRole('checkbox')).toBeDisabled();

    await row.getByRole('link', { name: 'Weekly Signal #43' }).click();
    const drawer = page.getByRole('dialog', { name: 'Weekly Signal #43' });
    await expect(drawer).toContainText('Signal #43: the inbox is the new homepage');
    await expect(drawer.frameLocator('iframe[title^="E-mail preview"]').getByText('Feeds come and go')).toBeVisible();
    await drawer.getByRole('tab', { name: 'Text version' }).click();
    await expect(drawer.getByLabel('Plain-text part')).toContainText('Feeds come and go');

    await drawer.getByRole('button', { name: 'Reject', exact: true }).click();
    await drawer.getByRole('button', { name: 'Reject with reason' }).click();
    await expect(drawer).toContainText('Say what to change');
    await drawer.getByRole('button', { name: 'Cancel' }).click();

    await drawer.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(page.getByText('Approved “Weekly Signal #43”')).toBeVisible();
    await page.goto('/approvals');
    await expect(page.getByRole('row', { name: /Weekly Signal #43/ })).toHaveCount(0);
  });

  test('batch approve is possible only for viewed items; the drawer works at 390 px', async ({ page }) => {
    await signIn(page, PEOPLE.approver);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/approvals');
    const card = page.getByRole('link', { name: /Engaged readers/ });
    await expect(card).toContainText('Not yet viewed');
    await card.click();
    const drawer = page.getByRole('dialog', { name: 'Engaged readers' });
    await expect(drawer).toContainText('Estimated size now');
    await expect(drawer.getByRole('button', { name: 'Approve and publish' })).toBeInViewport();
    await drawer.getByRole('tab', { name: /Changes/ }).click();
    await expect(drawer).toContainText('condition');
    await drawer.getByRole('button', { name: 'Close' }).click();

    await page.setViewportSize({ width: 1440, height: 900 });
    const row = page.getByRole('row', { name: /Engaged readers/ });
    await expect(row).toContainText('Viewed');
    await row.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Approve 1 selected' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Approve 1' }).click();
    await expect(page.getByText(/Approved 1 change/)).toBeVisible();
    const list = await call(page.request, 'approvals.list', { status: 'approved' });
    expect(list.approvals.map((a: any) => a.artifactName)).toContain('Engaged readers');
  });

  test('a viewer sees no approve actions and no settings', async ({ page }) => {
    await signIn(page, PEOPLE.viewer);
    await page.goto('/approvals');
    await expect(page.getByRole('button', { name: /Approve selected/ })).toHaveCount(0);
    await page.getByRole('row', { name: /Newsletter signup/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Your role can review changes but not approve them.');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Providers' })).toHaveCount(0);
  });
});
