import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

// Phase 28 (#555) per-route release budgets, from the build manifest. Ceilings are decimal gzip kB
// (1 kB = 1,000 bytes), JS and CSS, each file compressed individually. The table and the reasoning
// live in docs/design/phase-28/skeletons-and-budgets.md. Never raise a ceiling here: split a lazy
// import or remove an accidental eager one.
type Chunk = {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
};

const rootDist = join(process.cwd(), 'apps/web/dist');
const dist =
  existsSync(join(rootDist, '.vite', 'manifest.json')) || !existsSync(join(process.cwd(), 'dist')) ? rootDist : join(process.cwd(), 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');
const hasBuild = existsSync(manifestPath);
const manifest: Record<string, Chunk> = hasBuild ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

/** A dedicated CI budget run must fail when the live build is missing, not skip silently. */
const REQUIRE = process.env.PHASE28_REQUIRE_BUNDLE === '1' || process.env.CI === 'true';
const describeBuild = hasBuild ? describe : REQUIRE ? describe : describe.skip;

const KB = 1_000;

function chunkKey(name: string): string | undefined {
  return Object.keys(manifest).find((key) => manifest[key]?.name === name);
}

/** Every module reachable through static imports. Dynamic imports are never followed implicitly. */
function closureOf(table: Record<string, Chunk>, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    const chunk = table[key];
    if (!chunk) continue;
    seen.add(key);
    for (const imported of chunk.imports ?? []) stack.push(imported);
  }
  return seen;
}

/** Emitted files for a closure: JS, its associated CSS, deduplicated, source maps excluded. */
function filesOf(table: Record<string, Chunk>, entries: string[]): string[] {
  const files = new Set<string>();
  for (const key of closureOf(table, entries)) {
    const chunk = table[key];
    if (!chunk) continue;
    if (chunk.file) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
  }
  return [...files];
}

function sizeOf(directory: string, files: string[]): { raw: number; gzip: number } {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const body = readFileSync(join(directory, file));
    raw += body.length;
    gzip += gzipSync(body).length;
  }
  return { raw, gzip };
}

function bytesOfGzipKb(kb: number): number {
  return Math.round(kb * KB);
}

function formatKb(bytes: number): string {
  return `${(bytes / KB).toFixed(2)} kB`;
}

function incremental(entries: string[], initialFiles: Set<string>): { files: string[]; raw: number; gzip: number } {
  const files = filesOf(manifest, entries).filter((file) => !initialFiles.has(file));
  return { files, ...sizeOf(dist, files) };
}

const HEAVY: [string, string[]][] = [
  ['GrapesJS', ['grapesjs']],
  ['MJML', ['mjml-core']],
  ['React Flow', ['@xyflow/react', 'reactflow']],
  ['ECharts', ['echarts']],
];

function heavyIn(files: string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(dist, file)).toString('latin1');
    for (const [name, markers] of HEAVY) if (markers.some((marker) => text.includes(marker))) found.add(name);
  }
  return [...found];
}

// Signed-out people get the entry, Root and the auth screens it imports eagerly. The route table is
// a dynamic import of Root, so it joins the signed-in closure with Shell before any route module.
const SIGNED_OUT_INITIAL = ['index.html', 'src/app/Root.tsx'];
const SIGNED_IN_INITIAL = [...SIGNED_OUT_INITIAL, 'src/app/Shell.tsx', chunkKey('routes') ?? 'routes'];

/** The per-route ceilings in skeletons-and-budgets.md (decimal gzip kB). */
type Budget = { route: string; entries: string[]; lazy: number };
const BUDGETS: Budget[] = [
  { route: '/', entries: ['src/pages/HomePage.tsx'], lazy: 25 },
  { route: '/approvals', entries: ['src/pages/approvals/ApprovalsPage.tsx'], lazy: 25 },
  {
    route: '/approvals/:id',
    entries: ['src/pages/approvals/ApprovalsPage.tsx', 'src/features/approvals/ApprovalDrawer.tsx'],
    lazy: 70,
  },
  { route: '/work/agents', entries: ['src/pages/settings/AgentsPage.tsx'], lazy: 35 },
  { route: '/work/agents/:id', entries: ['src/pages/settings/AgentPage.tsx'], lazy: 45 },
  { route: '/work/agents/library/:id', entries: ['src/pages/build/PromptPage.tsx'], lazy: 35 },
  { route: '/marketing/campaigns', entries: ['src/pages/build/CampaignsPage.tsx'], lazy: 20 },
  { route: '/marketing/campaigns/:id', entries: ['src/pages/build/CampaignPage.tsx'], lazy: 45 },
  { route: '/marketing/broadcasts', entries: ['src/pages/build/BroadcastsPage.tsx'], lazy: 25 },
  { route: '/marketing/broadcasts/:id', entries: ['src/pages/build/BroadcastPage.tsx'], lazy: 80 },
  { route: '/marketing/journeys', entries: ['src/pages/build/JourneysPage.tsx'], lazy: 20 },
  { route: '/marketing/journeys/:id', entries: ['src/pages/build/JourneyPage.tsx'], lazy: 130 },
  { route: '/marketing/experiences', entries: ['src/pages/build/ExperiencesPage.tsx'], lazy: 20 },
  { route: '/marketing/experiences/:id', entries: ['src/pages/build/ExperiencePage.tsx'], lazy: 40 },
  { route: '/audience/people', entries: ['src/pages/audience/PeoplePage.tsx', 'src/pages/audience/ImportsPage.tsx'], lazy: 30 },
  { route: '/audience/people/:id', entries: ['src/pages/audience/PersonPage.tsx'], lazy: 30 },
  { route: '/audience/segments', entries: ['src/pages/build/SegmentsPage.tsx'], lazy: 20 },
  { route: '/audience/segments/:id', entries: ['src/pages/build/SegmentPage.tsx'], lazy: 40 },
  { route: '/audience/forms', entries: ['src/pages/build/FormsPage.tsx'], lazy: 20 },
  { route: '/audience/forms/:id', entries: ['src/pages/build/FormPage.tsx'], lazy: 40 },
  { route: '/audience/consent', entries: ['src/pages/audience/ConsentPage.tsx'], lazy: 40 },
  { route: '/content/templates', entries: ['src/pages/design/TemplatesPage.tsx'], lazy: 35 },
  { route: '/content/templates/blocks/:id', entries: ['src/pages/design/BlockPage.tsx'], lazy: 40 },
  { route: '/content/templates/:id', entries: ['src/pages/design/TemplatePage.tsx'], lazy: 65 },
  { route: '/content/assets', entries: ['src/pages/design/AssetsPage.tsx'], lazy: 25 },
  { route: '/content/brand', entries: ['src/pages/design/BrandPage.tsx'], lazy: 40 },
  { route: '/insights/analytics', entries: ['src/pages/insights/AnalyticsPage.tsx'], lazy: 40 },
  { route: '/insights/messages', entries: ['src/pages/insights/MessagesPage.tsx'], lazy: 20 },
  { route: '/insights/deliverability', entries: ['src/pages/insights/DeliverabilityPage.tsx'], lazy: 35 },
  { route: '/insights/alerts', entries: ['src/pages/insights/AlertsPage.tsx'], lazy: 30 },
  { route: '/settings', entries: ['src/pages/settings/SettingsPage.tsx'], lazy: 20 },
  { route: '/settings/workspace', entries: ['src/pages/settings/WorkspacePage.tsx'], lazy: 20 },
  { route: '/settings/providers', entries: ['src/pages/settings/ProvidersPage.tsx'], lazy: 40 },
  { route: '/settings/integrations', entries: ['src/pages/settings/IntegrationsPage.tsx'], lazy: 55 },
  {
    route: '/settings/integrations/tokens/:id',
    entries: ['src/pages/settings/IntegrationsPage.tsx'],
    lazy: 55,
  },
  { route: '/settings/secrets', entries: ['src/pages/settings/SecretsPage.tsx'], lazy: 20 },
  { route: '/settings/users', entries: ['src/pages/settings/UsersPage.tsx'], lazy: 25 },
  { route: '/settings/approval-policy', entries: ['src/pages/settings/ApprovalPolicyPage.tsx'], lazy: 25 },
  { route: '/preferences', entries: ['src/pages/PreferencesPage.tsx'], lazy: 20 },
  { route: '/create', entries: ['src/pages/CreatePage.tsx'], lazy: 20 },
  // The artifact dispatcher inherits the destination type's ceiling; the largest existing
  // destination is the journey builder (130 kB lazy, 280 kB cold).
  { route: '/artifacts/:id', entries: ['src/pages/artifacts/ArtifactPage.tsx'], lazy: 130 },
];

/** Renderer and action closures with their own ceilings; automatic ones add to the cold total. */
const RENDERERS = [
  { name: 'ECharts', entry: chunkKey('ChartImpl') ?? 'src/components/ChartImpl.tsx', ceiling: 400 },
  { name: 'Visual e-mail authoring', entry: 'src/features/templates/VisualMjml.tsx', ceiling: 1120 },
  { name: 'Broadcast report action', entry: 'src/features/broadcasts/report/ReportEntry.tsx', ceiling: 30 },
  { name: 'Demo fixture closure', entry: 'src/features/phase27/integration/demo/DemoRoot.tsx', ceiling: 25 },
];

const actuals: { route: string; initial: number; lazy: number; cold: number; cap: number }[] = [];

// Fixtures for the accounting helpers: tiny files exercise gzip, CSS and dedup without a build.
const fixtureDir = mkdtempSync(join(tmpdir(), 'phase28-bundle-'));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('bundle accounting fixtures (#555)', () => {
  const table: Record<string, Chunk> = {
    'index.html': { file: 'index.js', isEntry: true, imports: ['_shared'], css: ['index.css'] },
    _shared: { file: 'shared.js' },
    'src/app/Root.tsx': { file: 'root.js', isDynamicEntry: true, imports: ['index.html'] },
    'src/page.tsx': { file: 'page.js', isDynamicEntry: true, imports: ['_shared'], css: ['page.css'] },
  };
  for (const [file, body] of [
    ['index.js', 'index'.repeat(100)],
    ['shared.js', 'shared'.repeat(100)],
    ['root.js', 'root'.repeat(100)],
    ['page.js', 'page'.repeat(100)],
    ['index.css', 'body{}'.repeat(100)],
    ['page.css', '.page{}'.repeat(100)],
  ] as const)
    writeFileSync(join(fixtureDir, file), body);

  it('deduplicates shared imports and counts CSS', () => {
    const files = filesOf(table, ['src/page.tsx']);
    expect(files.sort()).toEqual(['page.css', 'page.js', 'shared.js']);
    const size = sizeOf(fixtureDir, files);
    expect(size.gzip).toBeGreaterThan(0);
    expect(size.raw).toBeGreaterThan(size.gzip);
  });

  it('does not traverse dynamic imports, so an eager route stays out of a static closure', () => {
    const withDynamic = { ...table, 'src/page.tsx': { ...table['src/page.tsx'], dynamicImports: ['src/app/Root.tsx'] } };
    expect(filesOf(withDynamic, ['src/page.tsx'])).not.toContain('root.js');
  });

  it('returns nothing for a missing entry instead of inventing a zero-cost route', () => {
    expect(closureOf(table, ['src/missing.tsx']).size).toBe(0);
  });
});

describeBuild('phase 28 per-route budgets (#555)', () => {
  it('finds the entry and route table before traversing', () => {
    expect(manifest['index.html'], 'index.html is missing from the live manifest').toBeDefined();
    expect(manifest['src/app/Root.tsx'], 'Root is missing from the live manifest').toBeDefined();
    expect(manifest['src/app/Shell.tsx'], 'Shell is missing from the live manifest').toBeDefined();
    expect(chunkKey('routes'), 'the route table chunk is missing from the live manifest').toBeDefined();
    for (const chunk of Object.values(manifest)) expect(Object.hasOwn(chunk, 'file')).toBe(true);
  });

  it('signed-out initial closure stays under 110 gzip kB', () => {
    const files = filesOf(manifest, SIGNED_OUT_INITIAL);
    const { gzip } = sizeOf(dist, files);
    expect(gzip, `signed-out initial ${formatKb(gzip)} > 110.00 kB from ${files.join(', ')}`).toBeLessThanOrEqual(bytesOfGzipKb(110));
  });

  it('signed-in initial closure stays under 150 gzip kB', () => {
    const files = filesOf(manifest, SIGNED_IN_INITIAL);
    const { gzip } = sizeOf(dist, files);
    expect(gzip, `signed-in initial ${formatKb(gzip)} > 150.00 kB from ${files.join(', ')}`).toBeLessThanOrEqual(bytesOfGzipKb(150));
  });

  it('auth screens add no more than 10 gzip kB after signed-out initial', () => {
    const initialFiles = new Set(filesOf(manifest, SIGNED_OUT_INITIAL));
    const extra = incremental(['src/app/Root.tsx'], initialFiles);
    expect(extra.gzip, `auth lazy ${formatKb(extra.gzip)} > 10.00 kB`).toBeLessThanOrEqual(bytesOfGzipKb(10));
  });

  const initialFiles = new Set(filesOf(manifest, SIGNED_IN_INITIAL));
  const initialGzip = sizeOf(dist, [...initialFiles]).gzip;

  for (const budget of BUDGETS) {
    it(`${budget.route} lazy closure stays under ${budget.lazy} gzip kB`, () => {
      for (const entry of budget.entries) expect(manifest[entry], `${entry} is missing from the manifest`).toBeDefined();
      const result = incremental(budget.entries, initialFiles);
      const cold = initialGzip + result.gzip;
      actuals.push({ route: budget.route, initial: initialGzip, lazy: result.gzip, cold, cap: budget.lazy });
      const detail = `${budget.route}: lazy ${formatKb(result.gzip)} > ${budget.lazy}.00 kB; files ${result.files.join(', ')}`;
      expect(result.gzip, detail).toBeLessThanOrEqual(bytesOfGzipKb(budget.lazy));
    });

    it(`${budget.route} cold total stays under ${150 + budget.lazy} gzip kB`, () => {
      const result = incremental(budget.entries, initialFiles);
      const cold = initialGzip + result.gzip;
      expect(cold, `${budget.route}: cold ${formatKb(cold)} > ${150 + budget.lazy}.00 kB`).toBeLessThanOrEqual(
        bytesOfGzipKb(150 + budget.lazy),
      );
    });

    it(`${budget.route} loads no GrapesJS, MJML, React Flow or ECharts`, () => {
      // The journey builder is the one route whose canvas is React Flow by contract; keep the heavy
      // libraries out of every other route, including lists, auth and reviews.
      if (budget.route === '/marketing/journeys/:id') return;
      expect(heavyIn(filesOf(manifest, [...SIGNED_IN_INITIAL, ...budget.entries]))).toEqual([]);
    });
  }

  it('keeps every route in app/routes.tsx budgeted', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/app/routes.tsx'), 'utf8');
    const declared = [...source.matchAll(/\bpath:\s*'([^']+)'/g)].map((m) => m[1]);
    const budgeted = new Set(BUDGETS.map((b) => b.route));
    const missing = declared.filter((path) => !budgeted.has(path));
    expect(missing, `routes without a budget entry: ${missing.join(', ')}`).toEqual([]);
  });

  for (const renderer of RENDERERS) {
    it(`${renderer.name} has its own ${renderer.ceiling} gzip kB ceiling`, () => {
      expect(manifest[renderer.entry], `${renderer.name}: ${renderer.entry} is missing from the manifest`).toBeDefined();
      // Renderers are measured as their additional closure over the signed-in initial, so shared
      // runtime and CSS are counted once, exactly as the route tests do.
      const result = incremental([renderer.entry], initialFiles);
      expect(result.files.length, `${renderer.name}: no emitted file for ${renderer.entry}`).toBeGreaterThan(0);
      expect(
        result.gzip,
        `${renderer.name}: ${formatKb(result.gzip)} > ${renderer.ceiling}.00 kB from ${result.files.join(', ')}`,
      ).toBeLessThanOrEqual(bytesOfGzipKb(renderer.ceiling));
    });
  }

  it('keeps ECharts out of the auth, Home, list and review closures', () => {
    const entries = ['src/pages/HomePage.tsx', 'src/pages/approvals/ApprovalsPage.tsx', 'src/pages/audience/PeoplePage.tsx'];
    expect(heavyIn(filesOf(manifest, [...SIGNED_OUT_INITIAL, ...entries]))).toEqual([]);
  });

  it('adds automatically mounted charts to the analytics cold total', () => {
    const chart = incremental([chunkKey('ChartImpl') ?? 'src/components/ChartImpl.tsx'], initialFiles);
    const analytics = incremental(['src/pages/insights/AnalyticsPage.tsx'], initialFiles);
    const cold = initialGzip + analytics.gzip + chart.gzip;
    expect(cold, `Analytics with chart: ${formatKb(cold)} > 590.00 kB`).toBeLessThanOrEqual(bytesOfGzipKb(590));
  });

  it('adds the automatically mounted visual editor to the template cold total', () => {
    const editor = incremental(['src/features/templates/VisualMjml.tsx'], initialFiles);
    const template = incremental(['src/pages/design/TemplatePage.tsx'], initialFiles);
    const cold = initialGzip + template.gzip + editor.gzip;
    expect(cold, `Template with visual editor: ${formatKb(cold)} > 1335.00 kB`).toBeLessThanOrEqual(bytesOfGzipKb(1335));
  });

  it('keeps the demo fixture closure out of every signed-in route', () => {
    for (const budget of BUDGETS) {
      const files = filesOf(manifest, [...SIGNED_IN_INITIAL, ...budget.entries]);
      expect(
        files.some((file) => file.includes('DemoRoot')),
        `${budget.route} eagerly loads DemoRoot`,
      ).toBe(false);
    }
  });

  it('prints the manifest-derived actuals for release evidence', () => {
    const rows = [...actuals].sort((a, b) => a.route.localeCompare(b.route));
    const lines = rows.map(
      (row) => `| ${row.route} | ${formatKb(row.initial)} | ${formatKb(row.lazy)} | ${formatKb(row.cold)} | ${row.cap} |`,
    );
    console.log(`\n| Route | Initial | Lazy | Cold | Cap |\n| --- | ---: | ---: | ---: | ---: |\n${lines.join('\n')}\n`);
    expect(rows).toHaveLength(BUDGETS.length);
  });
});
