// Screenshots of every admin route for review and docs/design/screenshots (seeded server required).
//
//   node e2e/screenshots.mjs <outDir> [--only name,name] [--widths 1440,768,390] [--themes light,dark]
//
// The routes come from apps/web/src/app/nav.ts plus the seeded detail pages (see e2e/matrix.mjs).
// Every shot disables motion, freezes the clock, waits for fonts, images and data (no skeletons)
// and masks relative times, dates and ids, so two runs of the same build differ only by intent.
//
//   BASE=http://localhost:3200 node e2e/screenshots.mjs reports/shots
//   CHROMIUM=/usr/bin/chromium node e2e/screenshots.mjs reports/shots --only approvals,people
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { buildMatrix, capture, loadFixtureIds, primePage, settle, THEMES, WIDTHS } from './matrix.mjs';

const args = process.argv.slice(2);
const value = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1].split(',') : d;
};
const out = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')) ?? 'screenshots';
const only = value('only', null);
const widths = value('widths', WIDTHS.map(String)).map(Number);
const themes = value('themes', THEMES);
const mask = !args.includes('--no-mask');
const base = process.env.BASE ?? process.env.E2E_BASE ?? 'http://localhost:3100';
const email = process.env.EMAIL ?? 'alex@example.com';
const password = process.env.PASSWORD ?? 'correct-horse-battery-staple';

mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  // Chromium needs this where /dev/shm is the container default of 64 MB.
  args: ['--disable-dev-shm-usage'],
});
const signedIn = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const signIn = await signedIn.request.post(`${base}/api/auth/sign-in/email`, {
  data: { email, password },
  headers: { origin: base },
});
if (!signIn.ok()) throw new Error(`sign-in for ${email}: ${signIn.status()} ${await signIn.text()}`);

const ids = await loadFixtureIds((name, input) => {
  return signedIn.request.post(`${base}/v1/${name}`, { data: input, headers: { 'content-type': 'application/json' } }).then(async (r) => {
    if (!r.ok()) throw new Error(`${name}: ${r.status()} ${await r.text()}`);
    return r.json();
  });
});

const routes = buildMatrix(ids).filter((r) => !only || only.includes(r.name));
const shots = [];

for (const route of routes) {
  for (const width of widths) {
    for (const theme of themes) {
      // Signed-out screens need a context without the session cookie.
      const context = route.signedOut ? await browser.newContext() : signedIn;
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await primePage(page, { theme, width, fixedTime: mask ? undefined : null });
        await page.goto(base + route.path);
        await settle(page);
        const file = `${out}/${route.name}-${width}-${theme}.png`;
        await capture(page, file, { mask });
        shots.push(file);
      } finally {
        await page.close();
        if (route.signedOut) await context.close();
      }
      if (errors.length) console.log(`  ${route.name}-${width}-${theme}: ${errors.join(' | ')}`);
    }
  }
  console.log('ok', route.name);
}

await browser.close();
console.log(`\n${shots.length} screenshots in ${out}`);
