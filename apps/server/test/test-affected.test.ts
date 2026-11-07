import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  packageNameOf,
  parseDocsProject,
  readDocsProject,
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
