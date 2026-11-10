import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectChangedFiles,
  packageNameOf,
  parseDocsProject,
  readDocsProject,
  resolveBase,
  resolveSpecifier,
  scanImports,
  selectAffected,
  vitestInvocations,
  workspacePackages,
} from '../../../scripts/test-affected.mjs';

// The mapping behind scripts/test-affected.mjs. It reads the real repository graph (package
// manifests, the Vitest config and imports), so the expectations below name files that exist
// today; the fixture file lists stand in for a diff.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const select = (files: string[]) => selectAffected({ root: ROOT, files });

describe('selectAffected: fine-grained mappings', () => {
  it('selects only the tests that import a web feature change', () => {
    const result = select(['apps/web/src/features/journey/Builder.tsx']);
    const web = result.selections.web.files ?? [];

    expect(result.full).toBe(false);
    expect(web).toContain('apps/web/test/journeyBuilderCounts.test.tsx');
    expect(web.length).toBeLessThan(20);
    expect(result.selections.server.files).toEqual([]);
    expect(result.selections.packages.files).toEqual([]);
    expect(result.selections.docs.files).toEqual([]);
  });

  it('selects a changed test file in its own project', () => {
    expect(select(['apps/web/test/journeyBuilderCounts.test.tsx']).selections.web.files).toEqual([
      'apps/web/test/journeyBuilderCounts.test.tsx',
    ]);
    expect(select(['apps/server/test/phase7.test.ts']).selections.server.files).toEqual(['apps/server/test/phase7.test.ts']);
    expect(select(['packages/email/test/render.test.ts']).selections.packages.files).toEqual(['packages/email/test/render.test.ts']);
  });
});

describe('selectAffected: conservative whole-project mappings', () => {
  it('runs server, docs, packages and web for a package source change web imports', () => {
    const result = select(['packages/analytics/src/registry.ts']);

    expect(result.full).toBe(false);
    // The web test labels.test.ts imports packages/analytics/src/registry.ts directly.
    expect(result.selections.web.files).toBeNull();
    expect(result.selections.server.files).toBeNull();
    expect(result.selections.docs.files).toBeNull();
    expect(result.selections.packages.files).toBeNull();
    expect(result.selections.server.reasons.join(' ')).toContain('static import scan cannot see harness, subprocess and CLI paths');
  });

  it('runs docs and server (and packages) for a server source change, without web', () => {
    const result = select(['apps/server/src/registry.ts']);

    expect(result.selections.docs.files).toBeNull();
    expect(result.selections.server.files).toBeNull();
    expect(result.selections.packages.files).toBeNull();
    // Web only follows package sources it imports; no package changed here.
    expect(result.selections.web.files).toEqual([]);
  });

  it('runs the whole server project for a CLI path reached only by a subprocess', () => {
    const result = select(['apps/server/src/ops/upgrade-notes.ts']);

    expect(result.selections.server.files).toBeNull();
    expect(result.selections.docs.files).toBeNull();
    expect(result.selections.packages.files).toBeNull();
  });

  it('runs the whole server project when the test harness changes', () => {
    const result = select(['apps/server/test/harness.ts']);

    expect(result.selections.server.files).toBeNull();
    expect(result.selections.server.reasons.join(' ')).toContain('static import scan cannot see harness');
  });

  it('runs the whole projects and suggests the e2e smoke run for a server e2e helper', () => {
    const result = select(['apps/server/test/e2e/server.ts']);

    expect(result.selections.server.files).toBeNull();
    expect(result.selections.docs.files).toBeNull();
    expect(result.selections.packages.files).toBeNull();
    expect(result.suggestions.join(' ')).toContain('scripts/e2e-docker.sh smoke');
  });
});

describe('selectAffected: the docs project comes from vitest.config.mts', () => {
  it('parses the docs list without a copied constant', () => {
    const source = readFileSync(join(ROOT, 'vitest.config.mts'), 'utf8');
    const block = /const\s+docs\s*=\s*\[([\s\S]*?)\]\s*;/.exec(source)?.[1] ?? '';
    const fromConfig = [...block.matchAll(/['"]([^'"]+\.test\.[cm]?tsx?)['"]/g)].map((match) => match[1]);

    expect(fromConfig.length).toBeGreaterThan(0);
    expect(readDocsProject(ROOT)).toEqual(fromConfig);
  });

  it('picks up new docs tests added to the config (for example #521)', () => {
    const added = ['apps/server/test/changelog.test.ts', 'apps/server/test/release-tooling.test.ts'];
    const source = `const docs = [\n  '${added[0]}',\n  '${added[1]}',\n];\n`;

    expect(parseDocsProject(source)).toEqual(added);
  });

  it('routes every configured docs test to the docs project, not the server project', () => {
    const docsFiles = readDocsProject(ROOT);
    expect(docsFiles).not.toBeNull();

    for (const file of docsFiles ?? []) {
      const result = select([file]);
      expect(result.selections.docs.files, file).toEqual([file]);
      expect(result.selections.server.files, file).toEqual([]);
    }
  });
});

describe('selectAffected: full-suite fallbacks', () => {
  it('runs everything for an unknown path', () => {
    const result = select(['tools/unknown.bin']);

    expect(result.full).toBe(true);
    expect(result.selections.packages.files).toBeNull();
    expect(result.fullReasons.join(' ')).toContain('not classified');
  });

  it('runs everything for migrations, the Vitest config, the lockfile, test-support, manifests and CI', () => {
    for (const file of [
      'packages/db/migrations/0099_example.sql',
      'vitest.config.mts',
      'pnpm-lock.yaml',
      'test-support/harness.ts',
      'package.json',
      '.github/workflows/ci.yml',
    ]) {
      expect(select([file]).full, file).toBe(true);
    }
  });

  it('suggests the e2e smoke run for Playwright changes instead of selecting Vitest tests', () => {
    const result = select(['e2e/smoke.spec.ts']);

    expect(result.full).toBe(false);
    expect(result.selections.web.files).toEqual([]);
    expect(result.suggestions.join(' ')).toContain('scripts/e2e-docker.sh smoke');
    expect(vitestInvocations(result)).toEqual([]);
  });

  it('suggests every Playwright suite for an e2e helper or config change (#606)', () => {
    for (const file of ['e2e/helpers.ts', 'e2e/ports.ts', 'e2e/matrix.mjs', 'playwright.config.ts', 'playwright.visual.config.ts']) {
      const text = select([file]).suggestions.join('\n');
      for (const suite of ['smoke', 'functional', 'axe', 'visual']) {
        expect(text, `${file} should suggest ${suite}`).toContain(`scripts/e2e-docker.sh ${suite}`);
      }
    }
  });

  it('names the specs that import a changed e2e helper', () => {
    const text = select(['e2e/ports.ts']).suggestions.join(' ');
    // apps/server/test/e2e-ports.test.ts imports ports for Vitest, but a change there reaches the
    // Playwright specs through e2e/helpers.ts, so at least one spec is named.
    expect(text).toMatch(/e2e\/[\w-]+\.spec\.ts/);
  });

  it('suggests the visual suite for a visual spec change instead of only smoke (#606)', () => {
    expect(select(['e2e/visual.spec.ts']).suggestions.join(' ')).toContain('scripts/e2e-docker.sh visual');
  });

  it('runs whole projects for a package test helper imported outside its package (#522 re-check)', () => {
    for (const file of ['packages/profiles/test/consentCases.ts', 'packages/db/test/run.ts']) {
      const result = select([file]);
      expect(result.selections.server.files, file).toBeNull();
      expect(result.selections.packages.files, file).toBeNull();
      expect(result.selections.docs.files, file).toBeNull();
    }
  });

  it('treats a non-spec file under e2e/ as source, so its Vitest consumers run', () => {
    const result = select(['e2e/ports.ts']);
    // apps/server/test/e2e-ports.test.ts imports e2e/ports.ts.
    expect(result.selections.server.files).toBeNull();
    expect(vitestInvocations(result).length).toBeGreaterThan(0);
  });

  it('refuses to trust a docs list that contains comments', () => {
    expect(parseDocsProject("const docs = [\n  'a.test.ts',\n  // ];\n  'b.test.ts',\n];")).toBeNull();
  });

  it('passes extra Vitest arguments through', () => {
    const docsFile = (readDocsProject(ROOT) ?? [])[0];

    expect(vitestInvocations(select([docsFile]), ['--reporter=dot'])).toEqual([['run', '--project', 'docs', docsFile, '--reporter=dot']]);
  });
});

describe('the static import scan', () => {
  // Three real server test files, checked against an independent extraction of their import
  // specifiers. They use only static imports, so the two sets should agree exactly.
  const files = ['apps/server/test/phase4.test.ts', 'apps/server/test/phase7.test.ts', 'apps/server/test/harness.ts'];

  for (const file of files) {
    it(`matches the imports in ${file}`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const actual = new Set<string>();
      for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) actual.add(match[1]);
      for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) actual.add(match[1]);

      expect(scanImports(source)).toEqual([...actual].sort());
    });
  }

  it('resolves workspace package names to their source entry', () => {
    const packages = workspacePackages(ROOT);
    const fromTest = join(ROOT, 'apps/server/test/phase7.test.ts');
    const fromWeb = join(ROOT, 'apps/web/test/labels.test.ts');

    expect(packageNameOf('@agentic-marketing/email/testing')).toBe('@agentic-marketing/email');
    expect(packageNameOf('node:fs')).toBeNull();
    expect(resolveSpecifier(ROOT, packages, fromTest, '@agentic-marketing/email')).toBe('packages/email/src/index.ts');
    expect(resolveSpecifier(ROOT, packages, fromTest, '@agentic-marketing/ai/testing')).toBe('packages/ai/src/testing.ts');
    expect(resolveSpecifier(ROOT, packages, fromWeb, '@agentic-marketing/server/src/registry')).toBe('apps/server/src/registry.ts');
    expect(resolveSpecifier(ROOT, packages, fromTest, 'vitest')).toBeNull();
  });
});

describe('the comparison base (#552)', () => {
  const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-affected-'));
    gitIn(dir, 'init', '-q', '-b', 'main');
    gitIn(dir, 'config', 'user.email', 'affected@example.com');
    gitIn(dir, 'config', 'user.name', 'Affected Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
  };
  const commit = (dir: string, name: string) => {
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', name);
    return gitIn(dir, 'rev-parse', 'HEAD');
  };

  it('falls back to origin/main when no phase branch is an ancestor of HEAD', () => {
    const dir = repo();
    commit(dir, 'only');

    const chosen = resolveBase({ root: dir, env: {} });

    expect(chosen.base).toBe('origin/main');
    expect(chosen.reason).toMatch(/no origin\/feat\/phase-.* branch is an ancestor of HEAD/);
  });

  it('uses the phase branch a task branch was cut from', () => {
    const dir = repo();
    commit(dir, 'main');
    const phase = commit(dir, 'phase');
    gitIn(dir, 'update-ref', 'refs/remotes/origin/feat/phase-9', phase);
    commit(dir, 'task');

    const chosen = resolveBase({ root: dir, env: {} });

    expect(chosen.base).toBe('origin/feat/phase-9');
    expect(chosen.reason).toMatch(/ancestor of HEAD with the most recent merge-base/);
  });

  it('picks the nearest ancestor when several phase branches qualify, and ignores a diverged one', () => {
    const dir = repo();
    const main = commit(dir, 'main');
    const first = commit(dir, 'phase-1');
    gitIn(dir, 'update-ref', 'refs/remotes/origin/feat/phase-1', first);
    const second = commit(dir, 'phase-2');
    gitIn(dir, 'update-ref', 'refs/remotes/origin/feat/phase-2', second);
    // A later phase branched off main and never merged: reachable ref, not this branch's base.
    gitIn(dir, 'checkout', '-q', '-b', 'side', main);
    const diverged = commit(dir, 'phase-3');
    gitIn(dir, 'update-ref', 'refs/remotes/origin/feat/phase-3', diverged);
    gitIn(dir, 'checkout', '-q', 'main');
    commit(dir, 'task');

    const chosen = resolveBase({ root: dir, env: {} });

    expect(chosen.base).toBe('origin/feat/phase-2');
    expect(chosen.reason).toContain('2 phase branch(es)');
  });

  it('lets AM_AFFECTED_BASE override the phase branch and an explicit --base override both', () => {
    const dir = repo();
    commit(dir, 'main');
    const phase = commit(dir, 'phase');
    gitIn(dir, 'update-ref', 'refs/remotes/origin/feat/phase-7', phase);
    commit(dir, 'task');

    expect(resolveBase({ root: dir, env: { AM_AFFECTED_BASE: 'origin/from-env' } })).toEqual({
      base: 'origin/from-env',
      reason: 'AM_AFFECTED_BASE',
    });
    expect(resolveBase({ root: dir, explicit: 'origin/from-flag', env: { AM_AFFECTED_BASE: 'origin/from-env' } })).toEqual({
      base: 'origin/from-flag',
      reason: 'the explicit --base',
    });
  });

  it('diffs from the chosen phase branch, so an earlier task in the phase is not in the change set', () => {
    const dir = repo();
    commit(dir, 'main');
    const phase = commit(dir, 'phase');
    gitIn(dir, 'update-ref', 'refs/remotes/origin/feat/phase-4', phase);
    commit(dir, 'task');

    const collected = collectChangedFiles({ root: dir, env: {} });

    expect(collected.base).toBe('origin/feat/phase-4');
    expect(collected.files).toEqual(['task.txt']);
    expect(collected.reason).toMatch(/most recent merge-base/);
  });
});
