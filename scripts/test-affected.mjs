#!/usr/bin/env node
// Select the Vitest projects and files a change actually touches, so a local run does not pay for
// the whole 44-minute server project. The full suite still runs in CI for a phase PR and a release.
//
//   node scripts/test-affected.mjs --print                     what would run, from the nearest base to HEAD
//   node scripts/test-affected.mjs --run                       run it with npx vitest
//   node scripts/test-affected.mjs --base origin/main --print  another base
//   node scripts/test-affected.mjs --files a b c --print       map an explicit file list
//   node scripts/test-affected.mjs --run -- --reporter=dot     extra Vitest arguments after --
//
// Without --base, the comparison base is the nearest origin/feat/phase-* branch that is an
// ancestor of HEAD (the phase branch a task branch was cut from); otherwise origin/main. Setting
// AM_AFFECTED_BASE overrides that, and an explicit --base overrides both. The chosen base and the
// reason are printed, so a phase branch no longer diffs against main and runs the whole suite.
//
// Changed files are `git diff --name-only <base>...HEAD` plus staged, unstaged and untracked files.
// The mapping is deliberately conservative: a path it cannot classify, a migration, the Vitest
// config, test-support, a package manifest, the lockfile or CI runs the full suite. `--run` assumes
// the shared test stack is already in the environment:
//
//   eval "$(scripts/test-services.sh env)"
//
// Design (#522 review): only two mappings are fine-grained, because they are reliable:
//   - a changed test file runs that file in its own project (membership read from vitest.config.mts);
//   - a change confined to apps/web/src/features/<name>/ runs the web tests whose import graph
//     reaches it.
// Any server or package source, server test helper or apps/server/test/e2e file runs the whole
// server, docs and packages projects, and the whole web project when web tests import the package.
// A static import scan cannot see the harness path, subprocesses or the CLI bundle, so pretending
// to be precise there under-selects; this never does.
//
// The mapping is exported for apps/server/test/test-affected.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_BASE = 'origin/main';

const PLAYWRIGHT_CONFIGS = new Set(['playwright.config.ts', 'playwright.visual.config.ts']);
const PLAYWRIGHT_SPEC = /\.spec\.[cm]?tsx?$/;
// Every suite imports the shared e2e helpers and the Playwright configs (#606).
const E2E_SUITE_COMMANDS = [
  'scripts/e2e-docker.sh smoke',
  'scripts/e2e-docker.sh functional',
  'scripts/e2e-docker.sh axe',
  'scripts/e2e-docker.sh visual',
];
const PROJECTS = ['docs', 'packages', 'web', 'server'];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts)$/;
const posix = (path) => path.split(sep).join('/');

const isTestFile = (path) => TEST_FILE.test(posix(path));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every file under `dir`, skipping generated and dependency directories. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === 'dist-single' ||
      entry.name === 'test-results' ||
      entry.name === 'reports'
    ) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Workspace package name → { dir, rel, pkg } for packages/* and apps/*. */
export function workspacePackages(root) {
  const map = new Map();
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = readJson(manifest);
      map.set(pkg.name, { dir, rel: posix(relative(root, dir)), pkg });
    }
  }
  return map;
}

const resolved = new Map();

function resolveFile(path) {
  if (resolved.has(path)) return resolved.get(path);
  const candidates = [path];
  if (/\.(?:m?js|cjs)$/.test(path)) candidates.push(path.replace(/\.(?:m?js|cjs)$/, '.ts'), path.replace(/\.(?:m?js|cjs)$/, '.tsx'));
  for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.json']) candidates.push(`${path}${extension}`);
  for (const extension of ['.ts', '.tsx', '.mts', '.js']) candidates.push(join(path, `index${extension}`));
  let found = null;
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }
  resolved.set(path, found);
  return found;
}

/** The package a bare specifier names, or null for a relative path or a runtime builtin. */
export function packageNameOf(specifier) {
  const clean = specifier.split('?')[0].split('#')[0];
  if (!clean || clean.startsWith('.') || clean.startsWith('/') || clean.startsWith('node:')) return null;
  const parts = clean.split('/');
  if (clean.startsWith('@')) return parts.length >= 2 ? parts.slice(0, 2).join('/') : clean;
  return parts[0];
}

/** Resolve one import specifier to a repository-relative file, or null for an external module. */
export function resolveSpecifier(root, packages, fromFile, specifier) {
  const clean = specifier.split('?')[0].split('#')[0];
  if (!clean) return null;
  let target = null;
  if (clean.startsWith('.')) {
    target = resolve(dirname(fromFile), clean);
  } else if (clean.startsWith('/')) {
    target = join(root, clean);
  } else {
    const name = packageNameOf(clean);
    const workspace = name ? packages.get(name) : null;
    if (!workspace) return null;
    const parts = clean.split('/');
    const rest = clean.startsWith('@') ? parts.slice(2) : parts.slice(1);
    const subpath = rest.length ? `./${rest.join('/')}` : '.';
    const exported = workspace.pkg.exports;
    let mapped = typeof exported === 'string' ? exported : exported?.[subpath];
    if (mapped && typeof mapped === 'object') mapped = mapped.import ?? mapped.require ?? mapped.default ?? mapped.types;
    if (typeof mapped === 'string') target = join(workspace.dir, mapped);
    // apps/server has no exports map; the UI imports its sources as @agentic-marketing/server/src/….
    else if (rest.length) target = rest[0] === 'src' ? join(workspace.dir, ...rest) : join(workspace.dir, 'src', ...rest);
    else target = join(workspace.dir, 'src', 'index');
  }
  if (!target) return null;
  const found = resolveFile(target);
  if (!found || !inside(root, found)) return null;
  return posix(relative(root, found));
}

/**
 * Every module specifier in a TypeScript source file. `from '…'` covers static imports and
 * re-exports (including multiline clauses), the other patterns cover side-effect imports, dynamic
 * imports and `require`. The scan is static on purpose: no TypeScript program and no service.
 */
export function scanImports(source) {
  const found = new Set();
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Entry file → every repository file it reaches, following relative and workspace imports. */
function reachability(root, packages, entries, visit) {
  const adjacency = new Map();
  const importsOf = (file) => {
    if (adjacency.has(file)) return adjacency.get(file);
    let source = '';
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      // An unreadable file is a leaf.
    }
    const next = [];
    for (const specifier of scanImports(source)) {
      const target = resolveSpecifier(root, packages, join(root, file), specifier);
      if (target && target !== file && visit(target)) next.push(target);
    }
    adjacency.set(file, next);
    return next;
  };
  const map = new Map();
  for (const entry of entries) {
    const seen = new Set([entry]);
    const stack = [entry];
    while (stack.length) {
      for (const next of importsOf(stack.pop())) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    map.set(entry, seen);
  }
  return map;
}

/** Web test → every apps/web and packages/* source file it reaches. */
function webReachability(root, packages) {
  const entries = walk(join(root, 'apps/web'))
    .filter(isTestFile)
    .map((file) => posix(relative(root, file)));
  return reachability(root, packages, entries, (file) => file.startsWith('apps/web/') || file.startsWith('packages/'));
}

function workspaceDependencies(pkg) {
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.keys(declared).filter((name) => name.startsWith('@agentic-marketing/'));
}

/** Whether the admin UI depends on `name` at runtime, directly or through another package. */
function webDependsOn(packages, name) {
  const web = packages.get('@agentic-marketing/web');
  if (!web) return false;
  const seen = new Set();
  // Runtime dependencies only: apps/web lists @agentic-marketing/server as a devDependency for
  // types, and following that would make every package change run the whole web project.
  const stack = Object.keys(web.pkg.dependencies ?? {}).filter((dependency) => dependency.startsWith('@agentic-marketing/'));
  while (stack.length) {
    const dependency = stack.pop();
    if (dependency === name) return true;
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    const workspace = packages.get(dependency);
    if (workspace) stack.push(...workspaceDependencies(workspace.pkg));
  }
  return false;
}

/**
 * What the web tests and web sources import. Direct `packages/<name>/src/...` paths (the UI reads
 * the analytics registry that way) count, as do package names resolved through exports. An
 * unresolvable relative import makes the result unsure, and the caller then selects web anyway.
 */
function webPackageImports(root, packages) {
  const imported = new Set();
  let unsure = false;
  const files = [join(root, 'apps/web/test'), join(root, 'apps/web/src')]
    .flatMap((dir) => walk(dir))
    .filter((file) => SOURCE_EXTENSIONS.test(file));
  for (const file of files) {
    let source = '';
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      unsure = true;
      continue;
    }
    for (const specifier of scanImports(source)) {
      const name = packageNameOf(specifier);
      if (name && packages.has(name)) imported.add(name);
      if (name?.startsWith('@agentic-marketing/') && !packages.has(name)) unsure = true;
      const target = resolveSpecifier(root, packages, file, specifier);
      if (!target) {
        // A relative path that does not resolve might point anywhere; do not under-select.
        if (specifier.startsWith('.')) unsure = true;
        continue;
      }
      const direct = /^packages\/([^/]+)\/src\//.exec(target);
      if (direct) imported.add(`@agentic-marketing/${direct[1]}`);
    }
  }
  return { imported, unsure };
}

/**
 * The docs project's files, parsed from vitest.config.mts. There is deliberately no copied list:
 * a project that adds a test to the config is mapped correctly without touching this script.
 */
export function parseDocsProject(source) {
  const block = /(?:export\s+)?const\s+docs(?:\s*:\s*[^=]+)?\s*=\s*\[([\s\S]*?)\]\s*;/.exec(source);
  if (!block) return null;
  // Comments could hide or fake entries (a `// ];` inside the array ends this match early); an
  // unexpected shape returns null so the caller falls back to running more, never fewer.
  if (/\/\/|\/\*/.test(block[1])) return null;
  return [...block[1].matchAll(/['"]([^'"]+\.test\.[cm]?tsx?)['"]/g)].map((match) => match[1]);
}

export function readDocsProject(root = ROOT) {
  try {
    return parseDocsProject(readFileSync(join(root, 'vitest.config.mts'), 'utf8'));
  } catch {
    return null;
  }
}

/** The Vitest project a changed test file runs in, or null when it is in none. */
function projectForTestFile(file, docsFiles) {
  if (docsFiles?.includes(file)) return 'docs';
  if (file.startsWith('apps/server/test/') && isTestFile(file)) return 'server';
  if (file.startsWith('apps/web/') && isTestFile(file)) return 'web';
  if (/^packages\/[^/]+\/(?:test|src)\//.test(file) && isTestFile(file)) return 'packages';
  return null;
}

/** The reason a path forces the full suite, or null. */
function fullTriggerReason(file) {
  if (file === 'vitest.config.mts') return 'the Vitest projects configuration changed';
  if (file === 'package.json' || file.endsWith('/package.json')) return 'a package manifest changed';
  if (file === 'pnpm-lock.yaml') return 'the lockfile changed';
  if (file === 'test-support' || file.startsWith('test-support/')) return 'shared test support changed';
  if (file.startsWith('packages/db/migrations/')) return 'a database migration changed';
  if (file.startsWith('.github/')) return 'CI configuration changed';
  return null;
}

function classifyPath(file, packages, docsFiles) {
  const full = fullTriggerReason(file);
  if (full) return { kind: 'full', reason: full };
  // The Playwright configs name every suite, so a change there needs all four.
  if (PLAYWRIGHT_CONFIGS.has(file)) return { kind: 'e2eConfig' };
  // Playwright specs are browser-only; any other file under e2e/ (ports, helpers, matrix) can be
  // imported by Vitest tests too, so it counts as source and runs whole projects.
  if (file.startsWith('e2e/') && PLAYWRIGHT_SPEC.test(file)) return { kind: 'e2e' };
  if (file.startsWith('e2e/')) return { kind: 'source', e2e: true };
  // An e2e helper under apps/server/test is part of the server project's inputs, not a test.
  if (file.startsWith('apps/server/test/e2e/')) return { kind: 'source', e2e: true };
  // A changed test file runs in its own project.
  if (isTestFile(file)) {
    const project = projectForTestFile(file, docsFiles);
    if (project) return { kind: 'test', project };
    return { kind: 'unknown', reason: 'a test file outside every Vitest project' };
  }
  // Documentation is a project of its own; a Markdown file anywhere belongs to it.
  if (file.endsWith('.md') || file.startsWith('docs/')) return { kind: 'docs' };
  if (file.startsWith('apps/web/')) return { kind: 'web' };
  // Server source and test helpers: the whole projects, because subprocess/CLI paths are invisible.
  if (file.startsWith('apps/server/test/') || file.startsWith('apps/server/src/')) return { kind: 'source' };
  const match = /^packages\/([^/]+)\/(src|test)\//.exec(file);
  if (match) {
    const name = `@agentic-marketing/${match[1]}`;
    if (!packages.has(name)) return { kind: 'unknown', reason: `${match[1]} is not a workspace package` };
    if (match[2] === 'src') return { kind: 'source', package: name };
    return { kind: 'package-test-helper', package: name };
  }
  return { kind: 'unknown', reason: 'the path is not classified' };
}

/** The Playwright specs whose import graph reaches one of the changed e2e helpers. */
function specsReaching(root, packages, helpers) {
  const entries = walk(join(root, 'e2e'))
    .filter((file) => PLAYWRIGHT_SPEC.test(file))
    .map((file) => posix(relative(root, file)));
  if (!entries.length || !helpers.length) return [];
  const reach = reachability(
    root,
    packages,
    entries,
    (file) => file.startsWith('e2e/') || file.startsWith('apps/') || file.startsWith('packages/'),
  );
  const changed = new Set(helpers);
  return entries.filter((entry) => [...(reach.get(entry) ?? [])].some((file) => changed.has(file))).sort();
}

/** The "run every Playwright suite" suggestion for an e2e helper, config or spec change. */
function e2eSuggestion({ root, packages, helpers = [], reason }) {
  const suites = E2E_SUITE_COMMANDS.map((command) => `\`${command}\``).join(', ');
  const named = specsReaching(root, packages, helpers);
  const shown = named.length > 8 ? [...named.slice(0, 8), `${named.length - 8} more`] : named;
  const specs = shown.length ? `; specs that import them: ${shown.join(', ')}` : '';
  return `${reason}: run every Playwright suite (${suites})${specs}`;
}

function emptySelection() {
  return { files: [], reasons: [] };
}

function addFiles(result, project, files, reason) {
  const selection = result.selections[project];
  if (selection.files === null) return;
  const before = selection.files.length;
  const merged = new Set(selection.files);
  for (const file of files) merged.add(file);
  selection.files = [...merged].sort();
  if (selection.files.length > before) selection.reasons.push(reason);
}

function addProject(result, project, reason) {
  const selection = result.selections[project];
  selection.files = null;
  selection.reasons.push(reason);
}

function markFull(result, reasons) {
  result.full = true;
  result.fullReasons = [...reasons];
  for (const project of PROJECTS) {
    result.selections[project].files = null;
    result.selections[project].reasons = [...reasons];
  }
}

function normaliseChanged(files, root) {
  return [
    ...new Set(
      files
        .filter((file) => typeof file === 'string' && file.length > 0)
        .map((file) => {
          const absolute = isAbsolute(file) ? file : resolve(root, file);
          return inside(root, absolute) ? posix(relative(root, absolute)) : posix(file);
        }),
    ),
  ].sort();
}

/**
 * Map a changed-file list to projects and files. Pure file-system work: no git, no services.
 *
 * `files` is required; `collectChangedFiles` provides it from git in the CLI.
 */
export function selectAffected({ root = ROOT, files = [], base = null } = {}) {
  const packages = workspacePackages(root);
  const docsFiles = readDocsProject(root);
  const changed = normaliseChanged(files, root);
  const result = {
    base,
    changed,
    full: false,
    fullReasons: [],
    selections: { docs: emptySelection(), packages: emptySelection(), web: emptySelection(), server: emptySelection() },
    notes: [],
    suggestions: [],
  };
  if (docsFiles === null) result.notes.push('could not read the docs project list from vitest.config.mts');
  if (!changed.length) {
    result.notes.push('no changed files: nothing to run');
    return result;
  }

  const buckets = {
    docs: [],
    web: [],
    tests: [],
    sources: [],
    packageTestHelpers: [],
    e2e: [],
    e2eConfig: [],
  };
  const fullReasons = [];
  for (const file of changed) {
    const classified = classifyPath(file, packages, docsFiles);
    if (classified.kind === 'full') fullReasons.push(`${file}: ${classified.reason}`);
    else if (classified.kind === 'unknown') fullReasons.push(`${file}: ${classified.reason}, so run everything`);
    else if (classified.kind === 'test') buckets.tests.push({ file, project: classified.project, docsUnavailable: docsFiles === null });
    else if (classified.kind === 'source') buckets.sources.push({ file, package: classified.package, e2e: classified.e2e });
    else if (classified.kind === 'package-test-helper') buckets.packageTestHelpers.push({ file, package: classified.package });
    else buckets[classified.kind].push(file);
  }
  if (fullReasons.length) {
    markFull(result, fullReasons);
    return result;
  }

  if (buckets.e2eConfig.length) {
    result.suggestions.push(e2eSuggestion({ root, packages, reason: 'Playwright configuration changed' }));
  }
  if (buckets.e2e.length) {
    const suites = new Set();
    for (const file of buckets.e2e) {
      if (file.endsWith('visual.spec.ts')) suites.add('`scripts/e2e-docker.sh visual`');
      else if (file.endsWith('axe.spec.ts')) suites.add('`scripts/e2e-docker.sh axe`');
      else {
        suites.add('`scripts/e2e-docker.sh functional`');
        suites.add('`scripts/e2e-docker.sh smoke`');
      }
    }
    result.suggestions.push(`no Vitest tests for ${buckets.e2e.length} Playwright spec(s): run ${[...suites].join(', ')}`);
  }
  if (buckets.docs.length) {
    const named = buckets.docs.slice(0, 5).join(', ');
    const more = buckets.docs.length > 5 ? ` and ${buckets.docs.length - 5} more` : '';
    addProject(result, 'docs', `documentation path(s) changed: ${named}${more}`);
  }

  for (const { file, project, docsUnavailable } of buckets.tests) {
    if (docsUnavailable && file.startsWith('apps/server/test/')) {
      // Without the config's docs list a docs test cannot be told apart from a server test; run both.
      addProject(result, 'docs', 'the docs project list could not be read; run the docs project');
      addFiles(result, 'server', [file], `${file}: server test changed`);
      continue;
    }
    addFiles(result, project, [file], `${file}: test file changed`);
  }

  if (buckets.sources.length) {
    const reason = 'server/package source: whole projects (static import scan cannot see harness, subprocess and CLI paths)';
    addProject(result, 'server', reason);
    addProject(result, 'docs', reason);
    addProject(result, 'packages', reason);
    const packageNames = [...new Set(buckets.sources.map((source) => source.package).filter(Boolean))];
    if (packageNames.length) {
      const index = webPackageImports(root, packages);
      const named = packageNames.filter((name) => index.unsure || index.imported.has(name) || webDependsOn(packages, name));
      if (named.length) addProject(result, 'web', `${named.join(', ')}: web tests import it, so run the whole web project`);
    }
    const e2eHelpers = buckets.sources.filter((source) => source.e2e).map((source) => source.file);
    if (e2eHelpers.length) {
      result.suggestions.push(e2eSuggestion({ root, packages, helpers: e2eHelpers, reason: 'e2e helpers changed' }));
    }
  }

  // A package's test helper or fixture can be imported by other packages' tests and by server tests
  // (packages/db/test/run.ts, packages/profiles/test/consentCases.ts), so it runs whole projects.
  for (const { file, package: name } of buckets.packageTestHelpers) {
    const why = `${file}: package test helper or fixture changed (imported outside its package), so run whole projects`;
    for (const project of ['server', 'docs', 'packages']) addProject(result, project, why);
    const index = webPackageImports(root, packages);
    if (index.unsure || index.imported.has(name) || webDependsOn(packages, name)) addProject(result, 'web', why);
  }

  if (buckets.web.length) selectWeb(root, packages, result, buckets.web);
  return result;
}

function selectWeb(root, packages, result, files) {
  if (files.every(isTestFile)) {
    addFiles(result, 'web', files, `${files.length} web test file(s) changed`);
    return;
  }
  const featureOf = (file) => /^apps\/web\/src\/features\/([^/]+)\//.exec(file)?.[1] ?? null;
  const features = new Set(files.map(featureOf));
  if (!features.has(null)) {
    const reach = webReachability(root, packages);
    const matched = new Set();
    let complete = true;
    for (const feature of features) {
      const featureFiles = files.filter((file) => featureOf(file) === feature);
      const before = matched.size;
      for (const [test, seen] of reach) {
        if (featureFiles.some((file) => seen.has(file))) matched.add(test);
      }
      if (matched.size === before) {
        complete = false;
        break;
      }
    }
    if (complete) {
      addFiles(
        result,
        'web',
        [...matched].sort(),
        `web feature change (${[...features].join(', ')}): ${matched.size} test file(s) import it`,
      );
      return;
    }
    addProject(result, 'web', 'web feature change with no test importing it, so run the web project');
    return;
  }
  addProject(result, 'web', 'admin UI change outside a feature with matching tests, so run the web project');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Remote phase branches, the integration branches a task branch is cut from. */
export function phaseBranches(root = ROOT) {
  try {
    return git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/feat/phase-*'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The base to diff against when the caller names none. On a task branch cut from a phase branch,
 * `origin/main` includes every earlier task in the phase and the selection falls back to the whole
 * suite. The nearest phase branch is the one that is an ancestor of HEAD whose merge-base with HEAD
 * is closest: fewest commits between the merge-base and HEAD wins.
 */
export function resolveDefaultBase({ root = ROOT } = {}) {
  const candidates = [];
  for (const branch of phaseBranches(root)) {
    try {
      git(root, ['merge-base', '--is-ancestor', branch, 'HEAD']);
    } catch {
      continue; // Not merged into this branch: not its base.
    }
    const mergeBase = git(root, ['merge-base', branch, 'HEAD']).trim();
    const behind = Number(git(root, ['rev-list', '--count', `${mergeBase}..HEAD`]).trim());
    candidates.push({ branch, mergeBase, behind });
  }
  if (!candidates.length) {
    return { base: DEFAULT_BASE, reason: 'no origin/feat/phase-* branch is an ancestor of HEAD' };
  }
  candidates.sort((a, b) => a.behind - b.behind || a.branch.localeCompare(b.branch));
  const nearest = candidates[0];
  return {
    base: nearest.branch,
    reason: `nearest of ${candidates.length} phase branch(es): an ancestor of HEAD with the most recent merge-base (${nearest.behind} commit(s) since)`,
  };
}

/**
 * The comparison base and why: an explicit `--base` wins, then `AM_AFFECTED_BASE`, then the nearest
 * phase branch, then `origin/main`.
 */
export function resolveBase({ root = ROOT, explicit = null, env = process.env } = {}) {
  if (explicit) return { base: explicit, reason: 'the explicit --base' };
  if (env.AM_AFFECTED_BASE) return { base: env.AM_AFFECTED_BASE, reason: 'AM_AFFECTED_BASE' };
  return resolveDefaultBase({ root });
}

/**
 * The changed files from git: the merge base with `base` to HEAD, plus staged, unstaged and
 * untracked files. Returns a warning instead of failing when the base ref does not exist.
 */
export function collectChangedFiles({ root = ROOT, base = null, env = process.env } = {}) {
  const files = new Set();
  const chosen = resolveBase({ root, explicit: base, env });
  let resolvedBase = chosen.base;
  let warning = null;
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${resolvedBase}^{commit}`]);
  } catch {
    for (const fallback of ['main', 'origin/HEAD']) {
      try {
        git(root, ['rev-parse', '--verify', '--quiet', `${fallback}^{commit}`]);
        resolvedBase = fallback;
        warning = `base ${chosen.base} is not available; using ${fallback}`;
        break;
      } catch {
        // Try the next fallback.
      }
    }
    if (warning === null) {
      resolvedBase = null;
      warning = `base ${chosen.base} is not available; only staged, unstaged and untracked changes are mapped`;
    }
  }
  const add = (output) => {
    for (const line of output.split('\n')) if (line.trim()) files.add(line.trim());
  };
  if (resolvedBase) add(git(root, ['diff', '--name-only', '--no-renames', `${resolvedBase}...HEAD`]));
  add(git(root, ['diff', '--name-only', '--no-renames']));
  add(git(root, ['diff', '--name-only', '--no-renames', '--cached']));
  add(git(root, ['ls-files', '--others', '--exclude-standard']));
  return { files: [...files].sort(), base: resolvedBase, reason: chosen.reason, warning };
}

/**
 * One Vitest invocation per selected project. A single invocation would apply the file filters to
 * every selected project, so a whole-project selection next to a file list would run no tests in
 * the first project. Returns [] when nothing is selected.
 */
export function vitestInvocations(result, passthrough = []) {
  if (result.full) return [['run', ...passthrough]];
  const invocations = [];
  for (const project of PROJECTS) {
    const selection = result.selections[project];
    if (selection.files === null) invocations.push(['run', '--project', project, ...passthrough]);
    else if (selection.files.length) invocations.push(['run', '--project', project, ...selection.files, ...passthrough]);
  }
  return invocations;
}

export function formatHuman(result) {
  const lines = [];
  lines.push(`Changed files: ${result.changed.length}${result.base ? ` (base ${result.base})` : ''}`);
  if (result.baseReason) lines.push(`Base: ${result.base ?? 'none'}; ${result.baseReason}`);
  for (const file of result.changed) lines.push(`  ${file}`);
  lines.push('');
  if (result.full) {
    lines.push('Full suite: everything');
    for (const reason of result.fullReasons) lines.push(`  reason: ${reason}`);
  } else {
    lines.push('Selection:');
    let any = false;
    for (const project of PROJECTS) {
      const selection = result.selections[project];
      if (selection.files === null) {
        any = true;
        lines.push(`  ${project.padEnd(8)} entire project`);
      } else if (selection.files.length) {
        any = true;
        lines.push(`  ${project.padEnd(8)} ${selection.files.length} file(s)`);
        for (const file of selection.files) lines.push(`           ${file}`);
      }
      for (const reason of selection.reasons) lines.push(`           reason: ${reason}`);
    }
    if (!any) lines.push('  (none)');
  }
  if (result.notes.length) {
    lines.push('', 'Notes:');
    for (const note of result.notes) lines.push(`  - ${note}`);
  }
  if (result.suggestions.length) {
    lines.push('', 'Suggestions:');
    for (const suggestion of result.suggestions) lines.push(`  - ${suggestion}`);
  }
  return lines.join('\n');
}

function usageError(message) {
  console.error(`${message}\n`);
  console.error('usage: node scripts/test-affected.mjs [--base <ref>] [--files a b …] [--print] [--json] [--run] [-- extra vitest args]');
  process.exit(2);
}

function main(argv) {
  let base = null;
  let files = null;
  let print = false;
  let json = false;
  let run = false;
  let passthrough = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (argument === '--base') {
      base = argv[++index];
      if (!base) usageError('--base needs a git ref');
    } else if (argument === '--files') {
      files = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) files.push(argv[++index]);
      if (!files.length) usageError('--files needs at least one path');
    } else if (argument === '--print') {
      print = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--run') {
      run = true;
    } else if (argument === '--help' || argument === '-h') {
      console.log('usage: node scripts/test-affected.mjs [--base <ref>] [--files a b …] [--print] [--json] [--run] [-- extra vitest args]');
      process.exit(0);
    } else {
      usageError(`unknown argument: ${argument}`);
    }
  }

  let changed;
  let gitBase = base;
  let baseReason = null;
  let warning = null;
  if (files) {
    changed = files;
    const chosen = resolveBase({ root: ROOT, explicit: base });
    gitBase = chosen.base;
    baseReason = chosen.reason;
  } else {
    const collected = collectChangedFiles({ root: ROOT, base });
    changed = collected.files;
    gitBase = collected.base;
    baseReason = collected.reason;
    warning = collected.warning;
  }
  const result = selectAffected({ root: ROOT, files: changed, base: gitBase });
  result.baseReason = baseReason;
  if (warning) result.notes.push(warning);

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHuman(result));

  if (!run) {
    if (!print && !json) {
      // No explicit action still prints the plan; the last line repeats how to run it.
      console.log('\nRun it with --run (or `pnpm test:affected`).');
    }
    return 0;
  }

  const invocations = vitestInvocations(result, passthrough);
  if (!invocations.length) {
    console.log('\nNo Vitest tests selected; nothing to run.');
    return 0;
  }
  const needsStack =
    result.full ||
    result.selections.packages.files === null ||
    result.selections.packages.files.length > 0 ||
    result.selections.server.files === null ||
    result.selections.server.files.length > 0;
  if (needsStack && !process.env.TEST_DATABASE_URL) {
    console.error('\nwarning: TEST_DATABASE_URL is not set. Use: eval "$(scripts/test-services.sh env)"');
  }
  for (const invocation of invocations) {
    console.log(`\n$ npx vitest ${invocation.join(' ')}`);
    const child = spawnSync('npx', ['vitest', ...invocation], { cwd: ROOT, stdio: 'inherit' });
    if (child.status !== 0) return child.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
