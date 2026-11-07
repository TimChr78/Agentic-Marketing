// The admin route matrix (#433, #206): every route the admin UI has, at every width and theme, the
// fixture ids its detail pages need, and the deterministic page preparation that screenshots, the
// visual regression spec and the axe spec share.
//
// Plain ESM with no dependencies, so `node e2e/screenshots.mjs` and the Playwright specs import the
// same list. The list is derived from the information architecture: the paths in
// `apps/web/src/app/nav.ts` are read from source (a new nav entry is covered without editing this
// file) and the detail pages come from the seeded workspace.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file in the repository. Playwright runs with the config's directory as the working directory
 * and `node e2e/screenshots.mjs` is documented to run from the repository root; the parent is a
 * fallback for a shell started inside e2e/.
 */
function repoFile(relative) {
  for (const base of [process.cwd(), join(process.cwd(), '..')]) {
    const file = join(base, relative);
    if (existsSync(file)) return file;
  }
  throw new Error(`Cannot find ${relative}; run this from the repository root.`);
}

/** Capture widths and the fixed viewport height for each. */
export const WIDTHS = [1440, 768, 390];
export const HEIGHT = { 1440: 900, 768: 900, 390: 844 };
export const THEMES = ['light', 'dark'];

/**
 * Every capture uses the same instant, so relative times ("9 min ago"), countdowns and the
 * analytics date range do not move between runs. It matches the date the fixtures describe.
 */
export const FIXED_TIME = '2026-11-05T09:00:00.000Z';

/** Motion off, caret invisible: a screenshot must not catch a transition or a blinking cursor. */
export const FREEZE_CSS = '*{transition:none!important;animation:none!important;caret-color:transparent!important}';

/** Readable, stable file names for the nav paths; the committed docs screenshots keep these. */
const NAMES = {
  '/': 'home',
  '/approvals': 'approvals',
  '/work/agents': 'agents',
  '/marketing/campaigns': 'campaigns',
  '/marketing/broadcasts': 'broadcasts',
  '/marketing/journeys': 'journeys',
  '/marketing/experiences': 'experiences',
  '/audience/people': 'people',
  '/audience/segments': 'segments',
  '/audience/forms': 'forms',
  '/audience/consent': 'consent',
  '/content/templates': 'templates',
  '/content/assets': 'assets',
  '/content/brand': 'brand',
  '/insights/analytics': 'analytics',
  '/insights/messages': 'messages',
  '/insights/deliverability': 'deliverability',
  '/insights/alerts': 'alerts',
  '/settings': 'settings',
  '/settings/workspace': 'workspace',
  '/settings/providers': 'providers',
  '/settings/integrations': 'integrations',
  '/settings/secrets': 'secrets',
  '/settings/users': 'users',
  '/settings/approval-policy': 'approval-policy',
};

/** The nav paths, read from `nav.ts` so the information architecture stays the one source. */
export function navPaths() {
  const source = readFileSync(repoFile('apps/web/src/app/nav.ts'), 'utf8');
  return [...new Set([...source.matchAll(/\bpath:\s*'([^']+)'/g)].map((m) => m[1]))];
}

const slug = (path) => path.replace(/^\//, '').replaceAll('/', '-');

/** The nav routes, with the documented file names. */
export function navRoutes() {
  return navPaths().map((path) => ({ name: NAMES[path] ?? slug(path), path }));
}

/** The artifact types whose detail page the seed populates, and the review types of an approval. */
const ARTIFACT_DETAILS = [
  ['journey', 'journey'],
  ['broadcast', 'broadcast'],
  ['campaign', 'campaign'],
  ['form', 'form'],
  ['segment', 'segment'],
  ['experience', 'experience'],
  ['prompt', 'prompt'],
  ['template', 'email_template'],
  ['block', 'email_block'],
];
const APPROVALS = [
  ['email_template', 'email'],
  ['journey', 'journey'],
  ['form', 'form'],
  ['segment', 'segment'],
  ['broadcast', 'broadcast'],
];

/** Detail pages: one of each artifact type the seed has, a person, an agent, a token and each approval type. */
export function detailRoutes(ids = {}) {
  const a = ids.artifacts ?? {};
  const routes = [
    ['journey-builder', a.journey && `/marketing/journeys/${a.journey}`],
    ['broadcast', a.broadcast && `/marketing/broadcasts/${a.broadcast}`],
    ['campaign', a.campaign && `/marketing/campaigns/${a.campaign}`],
    ['form', a.form && `/audience/forms/${a.form}`],
    ['segment', a.segment && `/audience/segments/${a.segment}`],
    ['experience', a.experience && `/marketing/experiences/${a.experience}`],
    ['prompt', a.prompt && `/work/agents/library/${a.prompt}`],
    ['template', a.template && `/content/templates/${a.template}`],
    ['block', a.block && `/content/templates/blocks/${a.block}`],
    ['person', ids.person && `/audience/people/${ids.person}`],
    ['agent', ids.agent && `/work/agents/${ids.agent}`],
    ['token', ids.token && `/settings/integrations/tokens/${ids.token}`],
    ...APPROVALS.map(([type, name]) => [`approval-${name}`, ids.approvals?.[type] && `/approvals/${ids.approvals[type]}`]),
    ['approval-proposal', ids.proposal && `/approvals?proposal=${ids.proposal}`],
  ];
  // A detail page without a fixture keeps its name and has no path; the matrix leaves it out.
  return routes.map(([name, path]) => ({ name, path: path || null }));
}

/** Signed-out screens: the sign-in page is `/` without a session, plus the password reset request. */
export const SIGNED_OUT = [
  { name: 'signin', path: '/', signedOut: true },
  { name: 'forgot-password', path: '/forgot-password', signedOut: true },
];

/** Every route name, in order, whether or not this seed has a fixture for it. */
export function allRoutes(ids = {}) {
  return [{ name: 'home', path: '/' }, ...navRoutes(), ...detailRoutes(ids), ...SIGNED_OUT];
}

/** The whole matrix: home, every nav route, the detail pages the seed has, and the signed-out screens. */
export function buildMatrix(ids = {}) {
  const seen = new Set();
  return allRoutes(ids).filter((r) => r.path && !seen.has(r.name) && seen.add(r.name));
}

/** The route names, so a spec can declare one test per route before the fixtures are loaded. */
export function matrixNames() {
  const seen = new Set();
  return allRoutes()
    .map((r) => r.name)
    .filter((name) => !seen.has(name) && seen.add(name));
}

/** One command as the signed-in person (the seeded server speaks the same API the UI uses). */
export async function callCommand(request, base, name, input) {
  const r = await request.post(`${base}/v1/${name}`, { data: input, headers: { 'content-type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`${name}: ${r.status()} ${JSON.stringify(body)}`);
  return body;
}

/**
 * The ids the detail pages need, from the seeded workspace. Names prefer the rich fixtures (the
 * welcome journey, the reviewed broadcast) and fall back to the first item of each type.
 */
export async function loadFixtureIds(call) {
  const list = async (type) => (await call('artifacts.list', { type })).artifacts ?? [];
  const pick = async (type, preferred) => {
    const all = await list(type);
    return (preferred && all.find((x) => x.name === preferred)?.id) || all[0]?.id;
  };
  const artifacts = {};
  await Promise.all(
    ARTIFACT_DETAILS.map(async ([key, type]) => {
      const preferred = {
        journey: 'Welcome series',
        broadcast: 'Signal #42 resend to engaged readers',
        form: 'Newsletter signup',
        segment: 'Engaged readers',
        experience: 'Newsletter banner on articles',
        template: 'Weekly Signal #42',
      }[key];
      artifacts[key] = await pick(type, preferred);
    }),
  );

  const approvals = {};
  for (const a of (await call('approvals.list', { limit: 200 })).approvals ?? [])
    if (!approvals[a.artifactType]) approvals[a.artifactType] = a.id;
  const proposal = ((await call('workspace.proposals', { status: 'pending', limit: 50 })).proposals ?? [])[0]?.id;
  const person = ((await call('profiles.list', { limit: 50 })).profiles ?? [])[0]?.id;
  const agent = ((await call('agents.list', {})).agents ?? [])[0]?.id;
  const tokens = (await call('apiTokens.list', {})).tokens ?? [];
  const token = (tokens.find((t) => t.name === 'Hermes') ?? tokens[0])?.id;
  return { artifacts, approvals, proposal, person, agent, token };
}

/**
 * The theme and the frozen clock, before the app's own scripts run. `fixedTime: null` keeps the real
 * clock: artifacts and approvals carry the time the seed ran, so a frozen clock earlier than that
 * reads "in 20 h" in images meant for people (masked runs hide those texts anyway).
 */
export async function primePage(page, { theme = 'light', width = 1440, fixedTime = FIXED_TIME } = {}) {
  await page.setViewportSize({ width, height: HEIGHT[width] ?? 900 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  if (fixedTime) await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(
    ({ theme, css }) => {
      try {
        localStorage.setItem('am.theme', theme);
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key?.startsWith('am.theme.') && key !== 'am.theme.user') localStorage.setItem(key, theme);
        }
      } catch {
        // Storage can be unavailable; the emulateMedia colour scheme still picks the theme.
      }
      const apply = () => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head?.append(style);
      };
      if (document.head) apply();
      else document.addEventListener('DOMContentLoaded', apply, { once: true });
    },
    { theme, css: FREEZE_CSS },
  );
}

/** Waits until the page has painted its data: fonts and images loaded, no skeleton left. */
export async function settle(page, { timeout = 20_000 } = {}) {
  await page.waitForLoadState('domcontentloaded');
  // The shell paints after the session call; the sign-in form is the signed-out equivalent.
  await page.waitForFunction(() => document.querySelector('main#main, form, [role="main"]'), undefined, { timeout });
  // Skeletons appear with the first render, so give the page a beat before checking they are gone.
  await page.waitForTimeout(120);
  await page.waitForFunction(() => !document.querySelector('.am-skeleton'), undefined, { timeout, polling: 50 });
  await page.waitForFunction(
    () => document.fonts.status === 'loaded' && Array.from(document.images).every((img) => img.complete),
    undefined,
    { timeout },
  );
  // The e-mail editor removes GrapesJS's own chrome when it is ready; capture after that, not before.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.am-gjs-app')).every((el) => el.dataset.amGjsReady === 'true'),
    undefined,
    { timeout },
  );
  // The journey canvas (React Flow) mounts its nodes hidden until it has measured them; capture once
  // every canvas shows its nodes. CI once caught the builder with an empty canvas.
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.react-flow')).every((flow) => {
        const nodes = Array.from(flow.querySelectorAll('.react-flow__node'));
        return nodes.length > 0 && nodes.every((node) => getComputedStyle(node).visibility !== 'hidden');
      }),
    undefined,
    { timeout },
  );
  // Two frames, so charts (ECharts SVG) and layout effects have painted.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * Regions that legitimately move between runs: relative times, countdowns, absolute dates, raw
 * identifiers. Playwright masks them, so a pixel diff only reports an intended change. Only leaf
 * elements are marked, so a container (a card, a chart) is never masked as a whole.
 */
const VOLATILE = [
  /(?:^|\s)(?:just now|in \d+ (?:min|h|d)|\d+ (?:min|h|d) ago)(?:\s|$)/,
  /^Runs in .+ unless rejected$/,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?\b/,
  // Raw identifiers: a short prefix and a UUIDv7 body, e.g. prf_01a1ac6640c37db886e777537658fa67,
  // including the two shortened forms the UI shows (prf_01a1ac6640… and prf_01a1…f6a5).
  /\b[a-z]{2,6}_[0-9a-f]{8,}/,
  /\b[a-z]{2,6}_[0-9a-f]{4,}…[0-9a-f]{4}\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
];

/** Marks the volatile leaves and returns them as one mask locator. */
export async function volatileMasks(page) {
  await page.evaluate(
    (sources) => {
      const patterns = sources.map((source) => new RegExp(source, 'i'));
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length || ['SCRIPT', 'STYLE', 'TITLE'].includes(el.tagName)) continue;
        const text = (el.textContent ?? '').trim();
        if (!text || !patterns.some((re) => re.test(text))) continue;
        el.setAttribute('data-am-volatile', '');
        // A fixed placeholder, so the layout does not move when "9 min ago" becomes "1 d ago" on a
        // later seed: the mask covers it either way, but the box must keep its size.
        el.textContent = '…';
      }
    },
    VOLATILE.map((re) => re.source),
  );
  return [page.locator('[data-am-volatile]')];
}

/** The screenshot of one route at one width and theme, with the volatile regions masked. */
export async function capture(page, file, { mask = true } = {}) {
  const masks = mask ? await volatileMasks(page) : [];
  await page.screenshot({ path: file, mask: masks, animations: 'disabled', caret: 'hide' });
}
