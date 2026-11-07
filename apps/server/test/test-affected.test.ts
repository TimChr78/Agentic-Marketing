import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOCS_TEST_FILES,
  packageNameOf,
  resolveSpecifier,
  scanImports,
  selectAffected,
  vitestInvocations,
  workspacePackages,
} from '../../../scripts/test-affected.mjs';

// The mapping behind scripts/test-affected.mjs. It reads the real repository graph (package
// manifests and imports), so the expectations below name files that exist today; the fixture file
// lists stand in for a diff.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const select = (files: string[]) => selectAffected({ root: ROOT, files });
const selected = (files: string[] | null) => files ?? [];

describe('selectAffected', () => {
  it('selects only the web project for a UI feature change', () => {
    const result = select(['apps/web/src/features/journey/Builder.tsx']);

    expect(result.full).toBe(false);
    expect(selected(result.selections.web.files)).toContain('apps/web/test/journeyBuilderCounts.test.tsx');
    expect(result.selections.docs.files).toEqual([]);
    expect(result.selections.packages.files).toEqual([]);
    expect(result.selections.server.files).toEqual([]);
  });

  it('selects a web test file on its own when only that test changed', () => {
    const result = select(['apps/web/test/journeyBuilderCounts.test.tsx']);

    expect(result.selections.web.files).toEqual(['apps/web/test/journeyBuilderCounts.test.tsx']);
    expect(result.selections.server.files).toEqual([]);
  });

  it('selects a package, its dependants and the server tests that import it', () => {
    const result = select(['packages/email/src/gateway.ts']);
    const packages = selected(result.selections.packages.files);
    const server = selected(result.selections.server.files);

    expect(result.full).toBe(false);
    // Its own tests.
    expect(packages).toContain('packages/email/test/render.test.ts');
    // A package that depends on email, transitively (audience -> email).
    expect(packages).toContain('packages/audience/test/import.test.ts');
    // A server test with a direct import: `import { outbox } from '@agentic-marketing/email'`.
    expect(server).toContain('apps/server/test/phase7.test.ts');
    // The admin UI does not depend on email, so it stays out.
    expect(result.selections.web.files).toEqual([]);
  });

  it('runs the whole server project when the harness changes', () => {
    const result = select(['apps/server/test/harness.ts']);

    expect(result.selections.server.files).toBeNull();
    expect(result.selections.server.reasons.join(' ')).toMatch(/harness/);
    expect(result.full).toBe(false);
  });

  it('runs everything for a database migration', () => {
    const result = select(['packages/db/migrations/0099_example.sql']);

    expect(result.full).toBe(true);
    expect(result.selections.server.files).toBeNull();
    expect(vitestInvocations(result)).toEqual([['run']]);
  });

  it('selects the docs project for a documentation-only change', () => {
    const result = select(['docs/development.md']);

    expect(result.full).toBe(false);
    expect(result.selections.docs.files).toBeNull();
    expect(result.selections.packages.files).toEqual([]);
    expect(result.selections.web.files).toEqual([]);
    expect(result.selections.server.files).toEqual([]);
  });

  it('sends a docs-project test file to the docs project, not the server project', () => {
    const result = select([DOCS_TEST_FILES[0]]);

    expect(result.selections.docs.files).toBeNull();
    expect(result.selections.server.files).toEqual([]);
  });

  it('runs everything for an unknown path', () => {
    const result = select(['tools/unknown.bin']);

    expect(result.full).toBe(true);
    expect(result.selections.packages.files).toBeNull();
    expect(result.fullReasons.join(' ')).toContain('not classified');
  });

  it('runs everything for the Vitest config, the lockfile, test-support and CI', () => {
    for (const file of ['vitest.config.mts', 'pnpm-lock.yaml', 'test-support/harness.ts', '.github/workflows/ci.yml']) {
      expect(select([file]).full, file).toBe(true);
    }
  });

  it('suggests the e2e smoke run for Playwright changes instead of selecting Vitest tests', () => {
    const result = select(['e2e/smoke.spec.ts']);

    expect(result.full).toBe(false);
    expect(result.selections.docs.files).toEqual([]);
    expect(result.selections.web.files).toEqual([]);
    expect(result.suggestions.join(' ')).toContain('scripts/e2e-docker.sh smoke');
    expect(vitestInvocations(result)).toEqual([]);
  });

  it('passes extra Vitest arguments through', () => {
    const result = select(['docs/development.md']);

    expect(vitestInvocations(result, ['--reporter=dot'])).toEqual([['run', '--project', 'docs', '--reporter=dot']]);
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
    const fromWeb = join(ROOT, 'apps/web/test/journeyBuilderCounts.test.tsx');

    expect(packageNameOf('@agentic-marketing/email/testing')).toBe('@agentic-marketing/email');
    expect(packageNameOf('node:fs')).toBeNull();
    expect(resolveSpecifier(ROOT, packages, fromTest, '@agentic-marketing/email')).toBe('packages/email/src/index.ts');
    expect(resolveSpecifier(ROOT, packages, fromTest, '@agentic-marketing/ai/testing')).toBe('packages/ai/src/testing.ts');
    expect(resolveSpecifier(ROOT, packages, fromWeb, '@agentic-marketing/server/src/registry')).toBe('apps/server/src/registry.ts');
    expect(resolveSpecifier(ROOT, packages, fromTest, 'vitest')).toBeNull();
  });
});
