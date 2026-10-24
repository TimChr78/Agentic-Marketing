// Dev helper: node e2e/shot.mjs <path> [width] [theme] [email] [out]
// Signs in (when email given), opens the path and saves a screenshot to /tmp/shots.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const [path = '/', width = '1440', theme = 'light', email = 'alex@example.com', out] = process.argv.slice(2);
const base = process.env.BASE ?? 'http://localhost:5173';
mkdirSync('/tmp/shots', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 900 }, colorScheme: theme });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
if (email !== '-') {
  const r = await page.request.post(`${base}/api/auth/sign-in/email`, { data: { email, password: 'correct-horse-battery-staple' }, headers: { origin: base } });
  if (!r.ok()) console.log('sign-in', r.status(), await r.text());
}
await page.addInitScript((t) => localStorage.setItem('am.theme', t), theme);
await page.goto(base + path);
await page.waitForTimeout(Number(process.env.WAIT ?? 1500));
const file = `/tmp/shots/${out ?? path.replace(/\W+/g, '_')}-${width}-${theme}.png`;
await page.screenshot({ path: file, fullPage: process.env.FULL === '1' });
console.log(file);
await browser.close();
