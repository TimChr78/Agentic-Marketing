import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// #60: the live build must keep GrapesJS/MJML, React Flow and ECharts out of the entry chunk and
// the pages that should feel light. The e2e job builds the UI first, so this reads its manifest.
type Chunk = { file: string; imports?: string[] };

// `pnpm test` and the CI e2e step run from the repo root; a manual run from apps/web works too.
const rootDist = join(process.cwd(), 'apps/web/dist');
const dist = existsSync(join(rootDist, '.vite', 'manifest.json')) || !existsSync(join(process.cwd(), 'dist')) ? rootDist : join(process.cwd(), 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');
const hasBuild = existsSync(manifestPath);
const manifest: Record<string, Chunk> = hasBuild ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

const HEAVY: [string, string[]][] = [
  ['GrapesJS', ['grapesjs']],
  ['MJML', ['mjml-core']],
  ['React Flow', ['@xyflow/react', 'reactflow']],
  ['ECharts', ['echarts']],
];

const ENTRY_BUDGET = 240_000;
const ROUTES: { name: string; entries: string[]; budget: number }[] = [
  { name: 'entry', entries: ['index.html'], budget: ENTRY_BUDGET },
  { name: 'sign-in', entries: ['index.html', 'src/app/Root.tsx'], budget: 330_000 },
  { name: 'Approvals list', entries: ['src/pages/approvals/ApprovalsPage.tsx'], budget: 370_000 },
  { name: 'People list', entries: ['src/pages/audience/PeoplePage.tsx'], budget: 340_000 },
  { name: 'Messages list', entries: ['src/pages/insights/MessagesPage.tsx'], budget: 340_000 },
];

/** Chunks a route loads: its entry chunks plus every static import, never a dynamic import. */
function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) continue;
    seen.add(key);
    for (const imported of chunk.imports ?? []) stack.push(imported);
  }
  return seen;
}

function filesOf(entries: string[]): string[] {
  const files = new Set<string>();
  for (const key of closure(entries)) {
    const file = manifest[key]?.file;
    if (file) files.add(file);
  }
  return [...files];
}

function sizeOf(files: string[]): { raw: number; gzip: number } {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const body = readFileSync(join(dist, file));
    raw += body.length;
    gzip += gzipSync(body).length;
  }
  return { raw, gzip };
}

function heavyIn(files: string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(dist, file)).toString('latin1');
    for (const [name, markers] of HEAVY) if (markers.some((marker) => text.includes(marker))) found.add(name);
  }
  return [...found];
}

const describeBuild = hasBuild ? describe : describe.skip;

describeBuild('bundle split (#60)', () => {
  it('finds every route chunk in the build manifest', () => {
    for (const route of ROUTES) for (const entry of route.entries) expect(manifest[entry], `${entry} is missing from the manifest`).toBeDefined();
  });

  for (const route of ROUTES) {
    it(`${route.name} loads no GrapesJS, MJML, React Flow or ECharts`, () => {
      expect(heavyIn(filesOf(route.entries))).toEqual([]);
    });

    it(`${route.name} stays under its size budget`, () => {
      const files = filesOf(route.entries);
      const { raw, gzip } = sizeOf(files);
      const detail = `${route.name} loads ${raw} bytes (${gzip} gzip) from ${files.length} chunks`;
      expect(raw, detail).toBeLessThanOrEqual(route.budget);
    });
  }
});
