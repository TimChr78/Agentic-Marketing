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

  test('a template and its broadcast are one row, one review and one approval (#107)', async ({ page }) => {
    await signIn(page, PEOPLE.approver);
    await page.goto('/approvals');
    const row = page.getByRole('row', { name: /Send Signal #44/ });
    await expect(row).toContainText('+ 1 reviewed together');
    await expect(page.getByRole('row', { name: /Weekly Signal #44/ })).toHaveCount(0);

    await row.getByRole('link', { name: 'Send Signal #44' }).click();
    const drawer = page.getByRole('dialog', { name: 'Send Signal #44' });
    await expect(drawer).toContainText('Reviewed together');
    await expect(drawer).toContainText('reviewed together with this broadcast');
    await expect(
      drawer.frameLocator('iframe[title^="E-mail preview"]').getByText('This issue and its send were approved together.'),
    ).toBeVisible();
    await drawer.getByRole('button', { name: /Weekly Signal #44/ }).click();
    await expect(page.getByRole('dialog', { name: 'Weekly Signal #44' })).toContainText('Reviewed together');

    await page.getByRole('dialog', { name: 'Weekly Signal #44' }).getByRole('button', { name: 'Approve all 2 and publish' }).click();
    await expect(page.getByText(/Approved 2 changes/)).toBeVisible();
    const list = await call(page.request, 'approvals.list', { status: 'approved' });
    const names = (list as { approvals: { artifactName: string }[] }).approvals.map((a) => a.artifactName);
    expect(names).toContain('Weekly Signal #44');
    expect(names).toContain('Send Signal #44');
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
    // #62: at 390 px the tab row either fits every tab, or shows a fade that says it scrolls.
    const tablist = drawer.getByRole('tablist', { name: 'Review' });
    if (await tablist.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) {
      await expect(drawer.locator('[data-scroll-fade="right"]')).toHaveCount(1);
    } else {
      const viewport = page.viewportSize()!;
      for (const box of await tablist.getByRole('tab').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
      )) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(viewport.width + 1);
      }
    }
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
    expect((list as { approvals: { artifactName: string }[] }).approvals.map((a) => a.artifactName)).toContain('Engaged readers');
  });

  test('a viewer sees no approve actions and no settings', async ({ page }) => {
    await signIn(page, PEOPLE.viewer);
    await page.goto('/approvals');
    await expect(page.getByRole('button', { name: /Approve selected/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Workspace settings' })).toContainText('An admin decides workspace settings.');
    await page.getByRole('row', { name: /Newsletter signup/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Your role can review changes but not approve them.');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Providers' })).toHaveCount(0);
  });

  test('the owner approves the time zone Hermes proposed (#106)', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/approvals');
    const card = page.getByRole('region', { name: 'Workspace settings' });
    await expect(card).toContainText('Time zone:');
    await expect(card).toContainText('UTC');
    await expect(card).toContainText('Europe/Copenhagen');
    await expect(card).toContainText('Hermes');
    await expect(card).toContainText('token of Sam Rivera');
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Approved the workspace settings change')).toBeVisible();
    await expect(card).toHaveCount(0);
    const ws = await call(page.request, 'workspace.get', {});
    expect(ws.timeZone).toBe('Europe/Copenhagen');
  });
});
