import { expect, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

// Phase 18, #228: a person grants a mandate from the agent page, edits it with the structured
// editor and sees the active mandate (with its expiry) back on the agent page.

test('create a mandate for an agent and see it on the agent page (#228)', async ({ page }) => {
  await signIn(page, PEOPLE.owner);

  // A token acts as an agent the first time it calls a command.
  const name = `Mandate agent ${Date.now()}`;
  const created = await call<{ token: string }>(page.request, 'apiTokens.create', { name, scopes: ['artifacts:read'] });
  const used = await page.request.post('/v1/agents.list', {
    data: {},
    headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
  });
  expect(used.ok(), `the token's first call: ${await used.text()}`).toBeTruthy();

  const agents = await call<{ agents: { id: string; name: string }[] }>(page.request, 'agents.list', {});
  const agent = agents.agents.find((a) => a.name === name);
  expect(agent, 'the agent list has the new agent').toBeTruthy();

  await page.goto(`/settings/agents/${agent!.id}`);
  await expect(page.getByText('No active mandate')).toBeVisible();

  // The button prefills the agent; the editor opens on the new draft.
  await page.getByRole('button', { name: 'Create mandate' }).click();
  await expect(page).toHaveURL(/\/artifacts\/mnd_/);
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(agent!.id);
  await expect(page.getByLabel('Purpose', { exact: true })).toHaveValue(/Act for this workspace/);

  const artifactId = page.url().split('/').pop()!;
  await page.getByLabel('Purpose', { exact: true }).fill('Send the weekly newsletter within the mandate.');
  await page.getByLabel('Valid until', { exact: true }).fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/Draft saved|Saved as draft/)).toBeVisible();
  const saved = await call<{ version: { content: { agent: string; purpose: string } } }>(page.request, 'artifacts.get', { artifactId });
  expect(saved.version.content).toMatchObject({ agent: agent!.id, purpose: 'Send the weekly newsletter within the mandate.' });

  const published = await call<{ status: string }>(page.request, 'artifacts.requestPublish', { artifactId, note: 'E2E mandate' });
  expect(published.status).toBe('published');

  // Back on the agent page: the active mandate, its link and its expiry.
  await page.goto(`/settings/agents/${agent!.id}`);
  await expect(page.getByRole('link', { name: `${name} mandate` })).toBeVisible();
  await expect(page.getByText(/days left/)).toBeVisible();
  await expect(page.getByText(/Expires/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create mandate' })).toHaveCount(0);

  // Responsive: the mandate card stays in view at 390 px and 1440 px.
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('link', { name: `${name} mandate` })).toBeInViewport();
  }
});
