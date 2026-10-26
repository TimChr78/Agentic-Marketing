import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

test('journey builder: add by drag, connect, delete by keyboard and context menu, autosave (#33)', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  await page.goto('/build/journeys');
  await page.getByRole('button', { name: 'New journey' }).first().click();
  await page.getByRole('dialog').getByLabel('Name').fill('E2E onboarding');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/build\/journeys\/jrn_/);
  const id = page.url().split('/').pop()!;
  const canvas = page.locator('.react-flow');
  await expect(canvas.locator('.react-flow__node')).toHaveCount(2);

  // Drag "Wait" from the palette onto the canvas.
  const pane = await canvas.boundingBox();
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: 'Wait', exact: true }).dragTo(canvas, { targetPosition: { x: pane!.width - 160, y: pane!.height / 2 } });
  await expect(canvas.locator('.react-flow__node')).toHaveCount(3);
  const wait = canvas.locator('.react-flow__node').filter({ hasText: 'Wait' }).filter({ hasText: '1 day' });

  // Delete the trigger → exit connection from its context menu, then connect trigger → wait by dragging.
  // (Keyboard path: focus the connection and press Shift+F10; right-click does the same.)
  await canvas.locator('.react-flow__edge').first().focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Delete connection' }).click();
  await expect(canvas.locator('.react-flow__edge')).toHaveCount(0);
  const trigger = canvas.locator('.react-flow__node').filter({ hasText: 'Trigger' });
  const from = (await trigger.locator('.react-flow__handle-bottom').boundingBox())!;
  const to = (await wait.locator('.react-flow__handle-top').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(canvas.locator('.react-flow__edge')).toHaveCount(1);

  // Connect wait → exit with the keyboard-friendly inspector select.
  await wait.click();
  await page.getByLabel('Next step').selectOption({ label: 'Exit (Exit)' });
  await expect(canvas.locator('.react-flow__edge')).toHaveCount(2);

  // Add an e-mail after the wait (press in the palette), then delete it with the Delete key.
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: 'E-mail' }).click();
  const email = canvas.locator('.react-flow__node').filter({ hasText: 'Choose a template' });
  await expect(email).toHaveCount(1);
  await expect(email).toContainText('Incomplete');
  await email.click();
  await page.keyboard.press('Delete');
  await expect(email).toHaveCount(0);
  // Undo brings it back, redo removes it again.
  await page.keyboard.press('Control+z');
  await expect(email).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(email).toHaveCount(0);

  await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 15_000 });
  const saved = await call(page.request, 'artifacts.get', { artifactId: id });
  const nodes = saved.version.content.nodes as any[];
  expect(nodes.map((n) => n.kind).sort()).toEqual(['exit', 'trigger', 'wait']);
  const byKind = Object.fromEntries(nodes.map((n) => [n.kind, n]));
  expect(byKind.trigger.next).toEqual([{ to: byKind.wait.id }]);
  expect(byKind.wait.next).toEqual([{ to: byKind.exit.id }]);
  expect(byKind.wait.position).toBeTruthy();

  // A published journey stays published when a person moves a step: the layout is saved beside
  // the version, not as a draft (issue #117). A click alone must not move the step either.
  await call(page.request, 'artifacts.requestPublish', { artifactId: id, note: 'Ready for the e2e' });
  const live = await call(page.request, 'artifacts.get', { artifactId: id });
  expect(live.version.state).toBe('published');
  await wait.click();
  await page.waitForTimeout(1500); // past the autosave delay; a click must not have queued a save
  expect((await call(page.request, 'artifacts.get', { artifactId: id })).latestVersion).toBe(live.latestVersion);

  const box = (await wait.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('Layout saved')).toBeVisible({ timeout: 15_000 });
  const moved = await call(page.request, 'artifacts.get', { artifactId: id });
  expect(moved.latestVersion).toBe(live.latestVersion);
  expect(moved.version.state).toBe('published');
  expect(moved.layout.positions[byKind.wait.id]).not.toEqual(byKind.wait.position);
});
