#!/usr/bin/env node
// Changelog fragments (#521). Every change adds one small file under changelog.d/ instead of
// editing CHANGELOG.md, so parallel branches never conflict on the changelog. A release folds the
// fragments and the current [Unreleased] section into one version section.
//
//   node scripts/changelog.mjs check
//   node scripts/changelog.mjs build <version> [--date YYYY-MM-DD] [--dry-run] [--upgrade-file FILE]
//
// A fragment is changelog.d/<issue>-<slug>.md:
//
//   ---
//   section: Added
//   issues: [123]
//   ---
//   - What changed, in the changelog's voice.
//
// `section` is one of SECTIONS; `issues` is optional. `build` sorts fragments by their lowest issue
// number, then by file name, so the same fragments always produce the same section.
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSemver } from './release/semver.mjs';

export const SECTIONS = ['Added', 'Changed', 'Fixed', 'Security', 'Removed'];
export const FRAGMENT_NAME = /^\d+-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The keys and body of a `---` front-matter block; a file without one has an empty `data`. */
export function parseFrontMatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { data: {}, body: source.trim() };
  const data = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const entry = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!entry) continue;
    let value = entry[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[entry[1]] = value;
  }
  return { data, body: match[2].trim() };
}

function issueList(value) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : value.replace(/^\[|\]$/g, '').split(',');
  return values
    .map((item) => String(item).trim().replace(/^#/, ''))
    .filter(Boolean)
    .map((item) => (/^\d+$/.test(item) ? Number(item) : Number.NaN));
}

/** One parsed fragment. `name` is the file name, which makes the ordering deterministic. */
export function parseFragment(source, name) {
  const { data, body } = parseFrontMatter(source);
  const namedIssue = /^(\d+)-/.exec(name)?.[1];
  return {
    name,
    section: typeof data.section === 'string' ? data.section.trim() : '',
    issues: data.issues === undefined && namedIssue ? [Number(namedIssue)] : issueList(data.issues),
    text: body,
  };
}

/** Every fragment in `dir`, sorted by issue then file name. README.md is documentation, not a fragment. */
export function readFragments(dir = join(root, 'changelog.d')) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => parseFragment(readFileSync(join(dir, name), 'utf8'), name))
    .sort(compareFragments);
}

function lowestIssue(fragment) {
  const valid = fragment.issues.filter((issue) => Number.isInteger(issue));
  return valid.length ? Math.min(...valid) : Number.POSITIVE_INFINITY;
}

export function compareFragments(a, b) {
  const issue = lowestIssue(a) - lowestIssue(b);
  return issue !== 0 ? issue : a.name.localeCompare(b.name);
}

/** The problems with the fragments, as one line per problem. */
export function checkFragments(fragments) {
  const errors = [];
  const names = new Set();
  for (const fragment of fragments) {
    if (!FRAGMENT_NAME.test(fragment.name)) {
      errors.push(`${fragment.name}: name must be <issue>-<slug>.md, lower-case letters, digits and dashes`);
    }
    const lower = fragment.name.toLowerCase();
    if (names.has(lower)) errors.push(`${fragment.name}: duplicate file name (case-insensitive)`);
    names.add(lower);

    if (!SECTIONS.includes(fragment.section)) {
      errors.push(`${fragment.name}: section "${fragment.section || '(missing)'}" is not one of ${SECTIONS.join(', ')}`);
    }
    if (!fragment.text) {
      errors.push(`${fragment.name}: no bullet text`);
      continue;
    }
    if (fragment.issues.some((issue) => !Number.isInteger(issue))) {
      errors.push(`${fragment.name}: issues must be a list of numbers, e.g. issues: [123]`);
    }
    const badLine = fragment.text
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .find(({ line }) => line.trim() && !line.startsWith('- ') && !/^\s/.test(line));
    if (badLine) errors.push(`${fragment.name}:${badLine.index + 1}: every top-level line must be a "- " bullet`);
  }
  return errors;
}

/** Validate every fragment in `dir`. */
export function check(dir = join(root, 'changelog.d')) {
  const fragments = readFragments(dir);
  return { fragments, errors: checkFragments(fragments) };
}

/** Split a changelog into its preamble and `## [version]` sections. */
export function splitSections(changelog) {
  const lines = changelog.split(/\r?\n/);
  const first = lines.findIndex((line) => /^## \[/.test(line));
  const preamble = (first < 0 ? lines : lines.slice(0, first)).join('\n').replace(/\s+$/, '');
  const sections = [];
  let current = null;
  for (let index = first < 0 ? lines.length : first; index < lines.length; index++) {
    const heading = /^## \[([^\]]+)\](.*)$/.exec(lines[index]);
    if (heading) {
      current = { version: heading[1], heading: lines[index], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(lines[index]);
    }
  }
  return { preamble, sections };
}

/** `### Heading` subsections of a section body, merged when a heading repeats. */
function subsections(lines) {
  const map = new Map();
  let heading = null;
  const before = [];
  for (const line of lines) {
    const match = /^### (.+)$/.exec(line);
    if (match) {
      heading = match[1].trim();
      if (!map.has(heading)) map.set(heading, []);
      continue;
    }
    if (heading) map.get(heading).push(line);
    else before.push(line);
  }
  const bare = before.map((line) => line.trim()).filter(Boolean);
  if (bare.length) {
    throw new Error(`CHANGELOG.md [Unreleased] has text before its first ### section: "${bare[0]}"; move it under a section`);
  }
  for (const [name, body] of map) map.set(name, body.join('\n').trim());
  return map;
}

/** The generated `## [version]` section, without touching the filesystem. */
export function renderSection({ version, date, unreleased = new Map(), fragments = [], upgradeBlock, issues }) {
  let section = `## [${version}] - ${date}`;
  const used = new Set();
  for (const name of SECTIONS) {
    const bullets = [
      unreleased.get(name) ?? '',
      ...fragments.filter((fragment) => fragment.section === name).map((fragment) => fragment.text),
    ]
      .map((text) => text.trim())
      .filter(Boolean);
    used.add(name);
    if (bullets.length) section += `\n\n### ${name}\n\n${bullets.join('\n')}`;
  }
  // A section a fragment may use in the future is not silently dropped: keep unknown Unreleased
  // subsections after the canonical ones, before the upgrade block.
  for (const [name, body] of unreleased) {
    if (used.has(name) || name.startsWith('Upgrading from ')) continue;
    if (body) section += `\n\n### ${name}\n\n${body}`;
  }
  const preservedUpgrade = [...unreleased.entries()].find(([name]) => name.startsWith('Upgrading from '));
  const upgrade = upgradeBlock ?? (preservedUpgrade ? `### ${preservedUpgrade[0]}\n\n${preservedUpgrade[1]}` : undefined);
  if (upgrade?.trim()) section += `\n\n${upgrade.trim()}`;

  const numbers = issues ?? [...new Set(fragments.flatMap((fragment) => fragment.issues))];
  const sorted = [...new Set(numbers)].filter(Number.isInteger).sort((a, b) => a - b);
  if (sorted.length) section += `\n\n<!-- issues: ${sorted.join(', ')} -->`;
  return section;
}

/** Remove the hidden issue marker from preserved section text before it is rendered again. */
function stripIssuesMarker(text) {
  return text.replace(/<!--\s*issues:\s*[\d,\s]+\s*-->/g, '').trim();
}

/** The issue numbers in a section's `<!-- issues: … -->` marker. */
function sectionIssues(section) {
  const match = /<!--\s*issues:\s*([\d,\s]+)\s*-->/.exec(section);
  if (!match) return [];
  return [
    ...new Set(
      match[1]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter(Number.isInteger),
    ),
  ].sort((a, b) => a - b);
}

/**
 * Whether every bullet line of a fragment is already in its own subsection of the section body.
 * Matching on the section too matters (#671): a Security fragment whose bullet text repeats an
 * Added bullet is a new entry, not a fold of the old one.
 */
function sectionHasFragment(bulletsByHeading, fragment) {
  const lines = bulletsByHeading.get(fragment.section);
  if (!lines) return false;
  return fragment.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => lines.has(line));
}

/** The bullet lines of a section body per `### Heading`, without throwing on bare text. */
function bulletsByHeading(body) {
  const map = new Map();
  let heading = null;
  for (const line of body.split(/\r?\n/)) {
    const match = /^### (.+)$/.exec(line);
    if (match) {
      heading = match[1].trim();
      if (!map.has(heading)) map.set(heading, new Set());
      continue;
    }
    if (heading) map.get(heading).add(line.trim());
  }
  return map;
}

/** Replace a file atomically: a killed process leaves either the old file or the complete new one. */
function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The rename already consumed it.
    }
  }
}

/**
 * Fold `[Unreleased]` and the fragments into a `## [version]` section.
 *
 * With `dryRun`, nothing is written and `output` is the section that would be added. Otherwise the
 * changelog is replaced atomically, the consumed fragments are deleted after that write, and
 * `output` is the new changelog.
 *
 * Re-running after a kill between the write and the deletions is safe (#602): a version section that
 * already exists is kept, fragments whose bullets it already contains are dropped, and only a
 * fragment added after the crash is merged into it.
 */
export function build({
  version,
  date,
  dir = join(root, 'changelog.d'),
  changelogPath = join(root, 'CHANGELOG.md'),
  upgradeBlock,
  dryRun = false,
}) {
  if (!isSemver(version)) throw new Error(`not a version: ${version}`);
  const day = date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a date (YYYY-MM-DD): ${day}`);

  const fragments = readFragments(dir);
  const errors = checkFragments(fragments);
  if (errors.length) throw new Error(`invalid changelog fragments:\n${errors.join('\n')}`);

  const changelog = readFileSync(changelogPath, 'utf8');
  const { preamble, sections } = splitSections(changelog);
  const existingSection = sections.find((candidate) => candidate.version === version);
  const consumed = fragments.map((fragment) => fragment.name);

  if (existingSection) {
    const body = existingSection.lines.join('\n');
    const bullets = bulletsByHeading(body);
    const novel = fragments.filter((fragment) => !sectionHasFragment(bullets, fragment));
    const recorded = sectionIssues(body);
    // A folded fragment still names its issue (#671): if the marker lost one, the section is
    // rebuilt so the fragment can be dropped without losing the issue it recorded.
    const missing = [...new Set(fragments.flatMap((fragment) => fragment.issues))].filter(
      (issue) => Number.isInteger(issue) && !recorded.includes(issue),
    );
    if (!novel.length && !missing.length) {
      // Nothing was lost: the crash left fragments whose bullets the section already has.
      if (!dryRun) for (const fragment of fragments) rmSync(join(dir, fragment.name));
      const section = `${existingSection.heading}\n${body}`.trim();
      return { section, output: dryRun ? section : changelog, consumed };
    }

    // A fragment arrived after the crash: merge it without duplicating the folded ones.
    const preserved = subsections(existingSection.lines);
    for (const [name, text] of preserved) preserved.set(name, stripIssuesMarker(text));
    const dateMatch = /^## \[[^\]]+\](?:\s*-\s*(.+))?$/.exec(existingSection.heading);
    const section = renderSection({
      version,
      date: dateMatch?.[1]?.trim() || day,
      unreleased: preserved,
      fragments: novel,
      upgradeBlock,
      issues: [...recorded, ...missing, ...novel.flatMap((fragment) => fragment.issues)],
    });
    const next =
      [
        preamble,
        ...sections.map((candidate) =>
          candidate === existingSection ? section : `${candidate.heading}\n${candidate.lines.join('\n')}`.trim(),
        ),
      ]
        .filter(Boolean)
        .join('\n\n')
        .replace(/\s+$/, '') + '\n';

    if (dryRun) return { section, output: section, consumed };
    writeAtomic(changelogPath, next);
    for (const fragment of fragments) rmSync(join(dir, fragment.name));
    return { section, output: next, consumed };
  }

  const unreleasedSection = sections.find((section) => section.version === 'Unreleased');
  const unreleased = unreleasedSection ? subsections(unreleasedSection.lines) : new Map();
  const section = renderSection({ version, date: day, unreleased, fragments, upgradeBlock });

  const remaining = sections
    .filter((candidate) => candidate !== unreleasedSection)
    .map((candidate) => `${candidate.heading}\n${candidate.lines.join('\n')}`.trim());
  const next = [preamble, section, ...remaining].filter(Boolean).join('\n\n').replace(/\s+$/, '') + '\n';

  if (dryRun) return { section, output: section, consumed };
  writeAtomic(changelogPath, next);
  for (const fragment of fragments) rmSync(join(dir, fragment.name));
  return { section, output: next, consumed };
}

function parseBuildArgs(argv) {
  const options = { version: undefined, date: undefined, dryRun: false, upgradeFile: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--date') options.date = argv[++index];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--upgrade-file') options.upgradeFile = argv[++index];
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else if (!options.version) options.version = arg.replace(/^v/, '');
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.version)
    throw new Error('usage: node scripts/changelog.mjs build <version> [--date YYYY-MM-DD] [--dry-run] [--upgrade-file FILE]');
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'check') {
      const { fragments, errors } = check();
      if (errors.length) {
        console.error('changelog fragments:');
        for (const error of errors) console.error(`  ${error}`);
        process.exit(1);
      }
      console.log(`changelog fragments: ${fragments.length} checked`);
    } else if (command === 'build') {
      const options = parseBuildArgs(rest);
      const upgradeBlock = options.upgradeFile ? readFileSync(options.upgradeFile, 'utf8') : undefined;
      const result = build({ ...options, upgradeBlock });
      if (options.dryRun) {
        console.log(result.section);
        console.error(`changelog build: dry run, ${result.consumed.length} fragment(s) would be consumed`);
      } else {
        console.log(`changelog build: wrote ${options.version}, consumed ${result.consumed.length} fragment(s)`);
      }
    } else {
      console.error('usage: node scripts/changelog.mjs <check|build> ...');
      process.exit(1);
    }
  } catch (error) {
    console.error(`changelog: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
