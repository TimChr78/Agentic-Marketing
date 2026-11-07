import { expect, type Page, test } from '@playwright/test';
import { BASE, PASSWORD } from './helpers';
import { buildMatrix, callCommand, loadFixtureIds, primePage, settle, volatileMasks } from './matrix.mjs';

// Visual regression (#433): a stable subset of the route matrix at 1440 and 390 px, light and dark,
// against baselines committed under e2e/visual.spec.ts-snapshots. The whole matrix (every route,
// three widths, both themes) is the screenshots script and the CI artifact, not this spec.
//
// The subset is the screens the design system is judged on: the sign-in page, the approvals queue
// and a broadcast approval, the journey list and builder, a broadcast, a template, people, analytics,
// agents and an agent, and the workspace settings. It changes only with a reviewed baseline commit:
//   pnpm e2e:visual --update-snapshots     (in the Playwright container; see docs/development.md)

/** Route names from e2e/matrix.mjs, in the order they run. */
const SUBSET = [
  'signin',
  'approvals',
  'approval-broadcast',
  'journeys',
  'journey-builder',
  'broadcast',
  'template',
  'people',
  'analytics',
  'agents',
  'agent',
  'workspace',
];
const WIDTHS = [1440, 390];
const THEMES = ['light', 'dark'];

type Route = { name: string; path: string; signedOut?: boolean };
let matrix: Route[] = [];

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: BASE });
  const signIn = await request.post('/api/auth/sign-in/email', {
    data: { email: 'alex@example.com', password: PASSWORD },
    headers: { origin: BASE },
  });
  expect(signIn.ok(), `sign-in: ${await signIn.text()}`).toBeTruthy();
  const ids = await loadFixtureIds((name: string, input: unknown) => callCommand(request, BASE, name, input));
  matrix = buildMatrix(ids);
  await request.dispose();
});

async function signIn(page: Page) {
  const r = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'alex@example.com', password: PASSWORD },
    headers: { origin: BASE },
  });
  expect(r.ok(), `sign-in: ${await r.text()}`).toBeTruthy();
}

for (const name of SUBSET) {
  test(`${name} matches its baseline`, async ({ page }) => {
    const route = matrix.find((r) => r.name === name);
    expect(route, `route "${name}" is in the matrix`).toBeTruthy();
    if (!route!.signedOut) await signIn(page);

    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        // The signed-out screens run without the session cookie; a fresh context per test makes
        // clearing it safe for the rest of this test only.
        if (route!.signedOut) await page.context().clearCookies();
        await primePage(page, { theme, width });
        await page.goto(route!.path);
        await settle(page);
        // The signed-out screens must really be signed out (#442 review): the form, not the app.
        if (route!.signedOut) await expect(page.getByRole('textbox', { name: /e-mail/i }).first()).toBeVisible();
        // People is captured as a person first sees it: the first page, its count and Load more.
        await page.evaluate(() => window.scrollTo(0, 0));
        // Which people come first depends on when asynchronous activity bumped their last-seen time,
        // which differs between machines; the baseline guards the page's layout (header, count,
        // columns, row structure), so the per-person cells are masked like other volatile text.
        const mask = [...(await volatileMasks(page))];
        // People values (e-mail/name, a copied value, consent statuses and last seen) vary between
        // machines. Mask only those text hooks, not whole cells or phone cards, so layout
        // regressions inside a card still fail the comparison.
        if (name === 'people') {
          // A mask takes the size of what it covers, so the person-specific text gets a fixed
          // placeholder first; otherwise the boxes still differ with whoever comes first.
          await page.evaluate(() => {
            for (const el of document.querySelectorAll('[data-volatile]')) el.textContent = 'xxxxxxxxxx';
          });
          mask.push(page.locator('[data-volatile]'));
        }
        await expect(page).toHaveScreenshot(`${name}-${width}-${theme}.png`, { mask });
      }
    }
  });
}
