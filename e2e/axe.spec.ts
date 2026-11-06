import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { BASE, PASSWORD } from './helpers';
import { buildMatrix, callCommand, loadFixtureIds, matrixNames, primePage, settle } from './matrix.mjs';

// Accessibility (#206): axe-core over every route in the matrix (e2e/matrix.mjs), light and dark at
// 1440 px, with the WCAG 2.1/2.2 A and AA rules. The spec fails on any violation that is not in
// e2e/axe-known-issues.json, and prints what it found by rule, so the allowlist can shrink.
//
//   pnpm e2e --project axe            # just this spec
//   pnpm e2e                          # the functional suite and this spec
//
// It runs on the production build and the seeded server, like the rest of e2e.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const THEMES = ['light', 'dark'];

type KnownIssue = { rule: string; route: string; reason: string };
const known = (JSON.parse(readFileSync(join(process.cwd(), 'e2e/axe-known-issues.json'), 'utf8')) as { issues: KnownIssue[] }).issues;

type Route = { name: string; path: string; signedOut?: boolean };
let matrix: Route[] = [];

/** What the run found, by rule, so the summary names the wave's remaining work. */
const summary = new Map<string, { impact: string; routes: Set<string>; nodes: number; known: boolean }>();

const isKnown = (rule: string, route: string) => known.some((i) => i.rule === rule && (i.route === '*' || i.route === route));

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

test.afterAll(() => {
  const rows = [...summary.entries()].sort((a, b) => b[1].nodes - a[1].nodes || a[0].localeCompare(b[0]));
  console.log(`\naxe: ${rows.reduce((n, [, v]) => n + v.nodes, 0)} violation node(s) in ${rows.length} rule(s)`);
  if (!rows.length) console.log('  none');
  for (const [rule, v] of rows)
    console.log(`  ${v.known ? 'known ' : 'FAIL  '}${rule} (${v.impact}) — ${v.nodes} node(s) on ${[...v.routes].sort().join(', ')}`);
  console.log(`  allowlist: ${known.length} entr${known.length === 1 ? 'y' : 'ies'} in e2e/axe-known-issues.json\n`);
});

for (const name of matrixNames()) {
  test(`${name} has no accessibility violations`, async ({ page }) => {
    const route = matrix.find((r) => r.name === name);
    test.skip(!route, `${name} has no fixture in this seed`);
    if (!route) return;
    if (!route.signedOut) await signIn(page);

    for (const theme of THEMES) {
      if (route.signedOut) await page.context().clearCookies();
      await primePage(page, { theme, width: 1440 });
      await page.goto(route.path);
      await settle(page);
      // A signed-out route must show its form, not the app (#442 review).
      if (route.signedOut) await expect(page.getByLabel(/e-mail/i).first()).toBeVisible();

      // Preview frames are sandboxed renders of what subscribers see (an e-mail, a hosted page),
      // not admin UI: axe does not scan them. Traversing an opaque-origin frame crashes Chromium in
      // the Playwright container, so they are excluded as well as skipped.
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).options({ iframes: false }).exclude('iframe').analyze();
      const unexpected = violations.filter((v) => !isKnown(v.id, name));
      for (const v of violations) {
        const entry = summary.get(v.id) ?? { impact: v.impact ?? 'unknown', routes: new Set<string>(), nodes: 0, known: true };
        entry.routes.add(name);
        entry.nodes += v.nodes.length;
        entry.known = entry.known && isKnown(v.id, name);
        summary.set(v.id, entry);
      }

      const details = unexpected.map((v) => {
        const nodes = v.nodes.slice(0, 3).map((n) => `    ${n.target.join(' ')} — ${(n.failureSummary ?? '').split('\n')[0]}`);
        return `  ${v.id} (${v.impact}): ${v.help}\n${nodes.join('\n')}`;
      });
      console.log(
        violations.length
          ? `axe ${name} (${theme}): ${violations.map((v) => `${v.id} ×${v.nodes.length}${isKnown(v.id, name) ? ' (known)' : ''}`).join(', ')}`
          : `axe ${name} (${theme}): clean`,
      );
      expect(details, `${name} (${theme}): ${unexpected.length} axe violation(s) not in the allowlist`).toEqual([]);
    }
  });
}
