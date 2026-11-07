import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

// Leave the workspace fully on even if the test stops halfway, so later specs see the seeded defaults.
test.afterEach(async ({ page }) => {
  await call(page.request, 'workspace.setAutonomy', { switch: 'on' }).catch(() => {});
});

test('pause an agent with a reason, resume it, and switch the workspace to propose-only (#213, #215)', { tag: '@smoke' }, async ({
  page,
}) => {
  await signIn(page, PEOPLE.owner);

  // A token acts as an agent the first time it calls a command, with the token's name.
  const name = `Hermes e2e ${Date.now()}`;
  const created = await call<{ token: string }>(page.request, 'apiTokens.create', { name, scopes: ['artifacts:read'] });
  const used = await page.request.post('/v1/agents.list', {
    data: {},
    headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
  });
  expect(used.ok(), `the token's first call: ${await used.text()}`).toBeTruthy();

  await page.goto('/work/agents');
  // The agents table, not the comparison card below it, which also has a row per agent.
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: `Actions for ${name}` }) });
  await expect(row).toContainText('Active');

  // Pause with a reason: the status and the reason show at once.
  await row.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Pause' }).click();
  const pause = page.getByRole('dialog');
  await pause.getByRole('textbox', { name: 'Reason (optional)', exact: true }).fill('Budget review');
  await pause.getByRole('button', { name: 'Pause agent' }).click();
  await expect(row).toContainText('Paused');
  await expect(row).toContainText('Budget review');

  // Resume: resumable, with the same credentials.
  await row.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Resume' }).click();
  await expect(row).toContainText('Active');

  // Propose-only: every change beyond a draft waits for a person, and the top bar says so.
  // The autonomy controls now live in Settings -> Approval policy and agent autonomy.
  await page.goto('/settings/approval-policy?tab=autonomy');
  await page.getByRole('radio', { name: /^Propose only/ }).check();
  await page.getByRole('button', { name: 'Save autonomy' }).click();
  await expect(page.getByRole('link', { name: /Agents: propose only/ })).toBeVisible();

  // Back on: the indicator disappears.
  await page.getByRole('radio', { name: /^On/ }).check();
  await page.getByRole('button', { name: 'Save autonomy' }).click();
  await expect(page.getByRole('link', { name: /Agents: propose only/ })).toHaveCount(0);
});
