// Screenshots of every screen for review and docs/design/screenshots (seeded server required).
//   node e2e/screenshots.mjs <outDir> [--only name,name] [--widths 1440,768] [--themes light,dark]
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const out = args[0] ?? '/tmp/shots/all';
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1].split(',') : d;
};
const only = opt('only', null);
const widths = opt('widths', ['1440', '768']).map(Number);
const themes = opt('themes', ['light', 'dark']);
const base = process.env.BASE ?? 'http://localhost:3100';
const email = process.env.EMAIL ?? 'alex@example.com';
mkdirSync(out, { recursive: true });

async function api(req, name, input) {
  const r = await req.post(`${base}/v1/${name}`, { data: input });
  return r.json();
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const r = await ctx.request.post(`${base}/api/auth/sign-in/email`, {
  data: { email, password: 'correct-horse-battery-staple' },
  headers: { origin: base },
});
if (!r.ok()) throw new Error(await r.text());
const list = async (type) => (await api(ctx.request, 'artifacts.list', { type })).artifacts;
const find = async (type, name) => (await list(type)).find((a) => a.name === name)?.id ?? (await list(type))[0]?.id;
const approvals = (await api(ctx.request, 'approvals.list', {})).approvals;
const apr = (t) => approvals.find((a) => a.artifactType === t)?.id;
const tokens = (await api(ctx.request, 'apiTokens.list', {})).tokens;

const pages = [
  ['signin', '/', { signedOut: true }],
  ['approvals', '/approvals'],
  ['approval-email', `/approvals/${apr('email_template')}`],
  ['approval-journey', `/approvals/${apr('journey')}`],
  ['approval-form', `/approvals/${apr('form')}`],
  ['approval-segment', `/approvals/${apr('segment')}`],
  ['approval-broadcast', `/approvals/${apr('broadcast')}`],
  ['journeys', '/build/journeys'],
  ['journey-builder', `/build/journeys/${await find('journey', 'Welcome series')}`],
  ['broadcasts', '/build/broadcasts'],
  ['broadcast', `/build/broadcasts/${await find('broadcast')}`],
  ['forms', '/build/forms'],
  ['form', `/build/forms/${await find('form', 'Newsletter signup')}`],
  ['segments', '/build/segments'],
  ['segment', `/build/segments/${await find('segment', 'Engaged readers')}`],
  ['experiences', '/build/experiences'],
  ['prompts', '/build/prompts'],
  ['templates', '/design/templates'],
  ['template', `/design/templates/${await find('email_template', 'Weekly Signal #42')}`],
  ['assets', '/design/assets'],
  ['hosted-pages', '/design/hosted-pages'],
  ['brand', '/design/brand'],
  ['people', '/audience/people'],
  ['consent', '/audience/consent'],
  ['imports', '/audience/imports'],
  ['messages', '/insights/messages'],
  ['deliverability', '/insights/deliverability'],
  ['journey-stats', '/insights/journeys'],
  ['ai-usage', '/insights/ai'],
  ['providers', '/settings/providers'],
  ['integrations', '/settings/integrations'],
  ['token', `/settings/integrations/tokens/${tokens.find((t) => t.name === 'Hermes')?.id}`],
  ['secrets', '/settings/secrets'],
  ['users', '/settings/users'],
  ['approval-policy', '/settings/approval-policy'],
  ['purposes', '/settings/purposes'],
  ['workspace', '/settings/workspace'],
  ['preferences', '/settings/preferences'],
];

for (const [name, path, o = {}] of pages) {
  if (only && !only.includes(name)) continue;
  for (const width of name.startsWith('approval') && name !== 'approval-policy' ? [...widths, 390] : widths)
    for (const theme of themes) {
      const c = o.signedOut ? await browser.newContext({ viewport: { width, height: 900 } }) : ctx;
      const page = await c.newPage();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('am.theme', t);
          const u = localStorage.getItem('am.theme.user');
          if (u) localStorage.setItem(`am.theme.${u}`, t);
        } catch {}
      }, theme);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + path);
      await page.waitForTimeout(Number(process.env.WAIT ?? 2200));
      await page.screenshot({ path: `${out}/${name}-${width}-${theme}.png` });
      if (errors.length) console.log(name, errors.join(' | '));
      await page.close();
      if (o.signedOut) await c.close();
    }
  console.log('ok', name);
}
await browser.close();
