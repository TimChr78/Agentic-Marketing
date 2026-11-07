import { expect, test } from '@playwright/test';
import { BASE, PEOPLE, signIn } from './helpers';
import { callCommand, loadFixtureIds } from './matrix.mjs';

// Phase 24 navigation (#446): every legacy URL redirects before fetching, the New menu opens the
// existing create dialog, the palette shows recents from successful detail visits, and a viewer sees
// only what their permissions allow.

let broadcast: { id: string; name: string };

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: BASE });
  const r = await request.post('/api/auth/sign-in/email', {
    data: { email: PEOPLE.owner, password: 'correct-horse-battery-staple' },
    headers: { origin: BASE },
  });
  expect(r.ok(), `sign-in: ${await r.text()}`).toBeTruthy();
  const ids = await loadFixtureIds((name: string, input: unknown) => callCommand(request, BASE, name, input));
  broadcast = await callCommand(request, BASE, 'artifacts.get', { artifactId: ids.artifacts.broadcast });
  await request.dispose();
});

const REDIRECTS: { from: string; to: string; search?: string; hash?: string }[] = [
  { from: '/demo-signed-in', to: '/' },
  { from: '/build/campaigns', to: '/marketing/campaigns' },
  { from: '/build/campaigns/cmp_01', to: '/marketing/campaigns/cmp_01' },
  { from: '/build/broadcasts', to: '/marketing/broadcasts' },
  { from: '/build/broadcasts/brd_01', to: '/marketing/broadcasts/brd_01' },
  { from: '/build/journeys', to: '/marketing/journeys' },
  { from: '/build/journeys/jrn_01', to: '/marketing/journeys/jrn_01' },
  { from: '/build/experiences', to: '/marketing/experiences' },
  { from: '/build/experiences/exp_01', to: '/marketing/experiences/exp_01' },
  { from: '/build/segments', to: '/audience/segments' },
  { from: '/build/segments/seg_01', to: '/audience/segments/seg_01' },
  { from: '/build/forms', to: '/audience/forms' },
  { from: '/build/forms/frm_01', to: '/audience/forms/frm_01' },
  { from: '/build/prompts', to: '/work/agents?tab=library' },
  { from: '/build/prompts/prm_01', to: '/work/agents/library/prm_01' },
  { from: '/build/topics', to: '/audience/consent?tab=topics' },
  { from: '/build/recipes', to: '/create?tab=starters' },
  { from: '/design/templates', to: '/content/templates' },
  { from: '/design/templates/tpl_01', to: '/content/templates/tpl_01' },
  { from: '/design/blocks', to: '/content/templates?tab=blocks' },
  { from: '/design/blocks/blk_01', to: '/content/templates/blocks/blk_01' },
  { from: '/design/assets', to: '/content/assets' },
  { from: '/design/hosted-pages', to: '/content/brand?tab=subscriber-pages' },
  { from: '/design/brand', to: '/content/brand' },
  { from: '/audience/imports', to: '/audience/people?tab=imports' },
  { from: '/settings/agents', to: '/work/agents' },
  { from: '/settings/agents/agt_01', to: '/work/agents/agt_01' },
  { from: '/settings/purposes', to: '/audience/consent?tab=purposes' },
  { from: '/settings/preferences', to: '/preferences' },
  { from: '/insights/ai', to: '/insights/analytics?tab=ai' },
  { from: '/insights/journeys', to: '/marketing/journeys?view=reports' },
];

test.describe('legacy URLs redirect', () => {
  for (const row of REDIRECTS) {
    test(`${row.from} → ${row.to}`, async ({ page }) => {
      await signIn(page, PEOPLE.owner);
      await page.goto(row.from);
      await expect(page).toHaveURL(`${BASE}${row.to}`);
    });
  }

  test('journey stats carries its id, other query values and the hash to Report', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/insights/journeys?journey=jrn_42&from=2026-10-01#waiting');
    await expect(page).toHaveURL(`${BASE}/marketing/journeys/jrn_42?from=2026-10-01&tab=report#waiting`);
  });
});

test.describe('New and the command palette', () => {
  test('the New menu creates a broadcast draft from its canonical list', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Broadcast', exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/marketing/broadcasts?create=broadcast`);

    const dialog = page.getByRole('dialog', { name: 'New broadcast' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`E2E navigation broadcast ${Date.now()}`);
    await dialog.getByRole('combobox', { name: 'Template', exact: true }).selectOption({ index: 1 });
    await dialog.getByRole('combobox', { name: 'Segment', exact: true }).selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByText(/Created .* as a draft/)).toBeVisible();
    await expect(page).toHaveURL(/\/marketing\/broadcasts\/bct_/);
  });

  test('the palette shows a recent artifact after a successful detail visit', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto(`/marketing/broadcasts/${broadcast.id}`);
    // A detail visit records only after the read succeeds; the heading proves it loaded.
    await expect(page.getByRole('heading', { name: broadcast.name })).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search' });
    await expect(palette.getByText('Recents', { exact: true })).toBeVisible();
    await expect(palette.getByRole('option', { name: new RegExp(broadcast.name) })).toBeVisible();
    await palette.getByRole('button', { name: 'Clear recents' }).click();
    await expect(palette.getByText('Recents', { exact: true })).toHaveCount(0);
  });
});

test.describe('role visibility', () => {
  test('a viewer sees no destinations they cannot use, no New, and no admin Settings', async ({ page }) => {
    await signIn(page, PEOPLE.viewer);
    await page.goto('/');

    const main = page.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link', { name: 'People' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Message activity' })).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Segments' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Consent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/settings/integrations`);
    const settings = page.getByRole('navigation', { name: 'Settings' });
    await expect(settings.getByRole('link', { name: 'Integrations and API tokens' })).toBeVisible();
    await expect(settings.getByRole('link', { name: 'Approval policy and agent autonomy' })).toBeVisible();
    await expect(settings.getByRole('link', { name: 'Workspace' })).toHaveCount(0);
    await expect(settings.getByRole('link', { name: 'Providers' })).toHaveCount(0);
    await expect(settings.getByRole('link', { name: 'Secrets' })).toHaveCount(0);
    await expect(settings.getByRole('link', { name: 'Users and roles' })).toHaveCount(0);

    await page.goto('/settings/workspace');
    await expect(page.getByText("Your role can't open this page")).toBeVisible();
  });
});
