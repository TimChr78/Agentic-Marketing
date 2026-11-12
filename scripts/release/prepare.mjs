#!/usr/bin/env node
// Prepare a release in one pass (#521): bump every version surface, fold the changelog fragments
// and the [Unreleased] section into the release section, generate the "Upgrading from" block from
// facts (git and .env.example), keep ENV_SINCE current, and run the version check.
//
//   node scripts/release/prepare.mjs <version> [--date YYYY-MM-DD] [--previous <version>]
//   node scripts/release/prepare.mjs <version> --check
//
// The generated block leaves one TODO for a person: breaking changes cannot be inferred from a
// diff. --check fails while that TODO is still there, so it cannot reach a release by accident.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildChangelog, check as checkChangelog, splitSections } from '../changelog.mjs';
import { normalizeVersion } from './semver.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const JSON_SURFACES = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/sdk-js/package.json',
  'packages/edge-worker/package.json',
];

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, text) {
  if (read(path) !== text) writeFileSync(path, text);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The environment keys in an env file, including commented examples. */
export function envKeys(text) {
  const keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line) ?? /^#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/** The newest release section in CHANGELOG.md, i.e. the version this release upgrades from. */
export function findPreviousVersion(changelog, exclude) {
  const { sections } = splitSections(changelog);
  return sections.find((section) => /^\d+\.\d+\.\d+/.test(section.version) && section.version !== exclude)?.version ?? null;
}

/** The migration files added since `previous`, from the tag to HEAD. */
export function migrationsSince(root, previous) {
  let files;
  try {
    files = git(root, ['diff', '--name-only', '--diff-filter=A', `v${previous}..HEAD`, '--', 'packages/db/migrations']);
  } catch {
    throw new Error(`cannot diff v${previous}..HEAD; does tag v${previous} exist? (git fetch --tags)`);
  }
  return files
    .split(/\r?\n/)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/** The environment variables in .env.example that were not in it at the previous tag. */
export function envVarsSince(root, previous) {
  let before;
  try {
    before = git(root, ['show', `v${previous}:.env.example`]);
  } catch {
    throw new Error(`cannot read .env.example at v${previous}; does tag v${previous} exist? (git fetch --tags)`);
  }
  const old = envKeys(before);
  return [...envKeys(read(join(root, '.env.example')))].filter((key) => !old.has(key)).sort();
}

/** The release's `### Upgrading from …` block, generated from facts plus one explicit TODO. */
export function renderUpgradeBlock({ previous, version, migrations = [], envVars = [] }) {
  const migrationText = migrations.length ? `${migrations.map((file) => `\`${file}\``).join(', ')}.` : 'none.';
  const configurationText = envVars.length ? `${envVars.map((key) => `\`${key}\``).join(', ')}.` : 'no new environment variables.';
  return [
    `### Upgrading from ${previous}`,
    '',
    `- **Migrations:** ${migrationText}`,
    `- **Configuration:** ${configurationText}`,
    '- **Breaking changes:** TODO: describe any user-visible change to commands, artifacts, URLs or configuration, or write "none".',
    '- **Manual steps:** none.',
    `- **Upgrade:** download \`agentic-marketing-compose-${version}.tar.gz\`, replace \`docker-compose.yml\` with its copy, check configuration with \`AM_VERSION=${version} docker compose run --rm --no-deps -T app am doctor --env-file - < .env\`, set \`AM_VERSION=${version}\` in \`.env\`, then \`docker compose pull && docker compose up -d\` (Helm: chart ${version}). Run \`docker compose exec app am doctor\`.`,
  ].join('\n');
}

/** Bump every surface check-versions.mjs knows, plus the README's version default and release line. */
export function bumpVersions(root, version) {
  const changes = [];
  for (const file of JSON_SURFACES) {
    const path = join(root, file);
    const source = read(path);
    const next = source.replace(/^(\s*"version"\s*:\s*")[^"]+(")/m, `$1${version}$2`);
    if (next === source && !source.includes(`"version": "${version}"`)) throw new Error(`${file} has no "version" field`);
    write(path, next);
    changes.push(file);
  }

  const chartPath = join(root, 'deploy/helm/agentic-marketing/Chart.yaml');
  const chart = read(chartPath)
    .replace(/^(version:\s*)["']?[^"'\s]+["']?$/m, `$1${version}`)
    .replace(/^(appVersion:\s*)["']?[^"'\s]+["']?$/m, `$1"${version}"`);
  write(chartPath, chart);
  changes.push('deploy/helm/agentic-marketing/Chart.yaml');

  const envPath = join(root, '.env.example');
  write(envPath, read(envPath).replace(/^AM_VERSION=\S+$/m, `AM_VERSION=${version}`));
  changes.push('.env.example');

  const composePath = join(root, 'docker-compose.yml');
  write(composePath, read(composePath).replace(/(agentic-marketing:\$\{AM_VERSION:-)[^}]+(\})/, `$1${version}$2`));
  changes.push('docker-compose.yml');

  const readmePath = join(root, 'README.md');
  const line = version.split('.').slice(0, 2).join('.');
  const readme = read(readmePath);
  if (!/`AM_VERSION` \(default `[^`]+`\)/.test(readme) || !/current release is the \*\*[^*]+\*\* line/.test(readme)) {
    throw new Error('README.md has no AM_VERSION default or "current release is the **X.Y** line" sentence');
  }
  const next = readme
    .replace(/`AM_VERSION` \(default `[^`]+`\)/, `\`AM_VERSION\` (default \`${version}\`)`)
    .replace(/current release is the \*\*[^*]+\*\* line/, `current release is the **${line}** line`);
  write(readmePath, next);
  changes.push('README.md');
  return changes;
}

function envHistoryKeys(source) {
  const start = source.indexOf('export const ENV_SINCE: Record<string, string> = {');
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('cannot find ENV_SINCE in apps/server/src/ops/env-history.ts');
  const body = source.slice(start, end);
  return new Set([...body.matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]));
}

/** Keys .env.example documents that have no ENV_SINCE entry. */
export function missingEnvHistory(root) {
  const source = read(join(root, 'apps/server/src/ops/env-history.ts'));
  const known = envHistoryKeys(source);
  return [...envKeys(read(join(root, '.env.example')))].filter((key) => !known.has(key)).sort();
}

/**
 * Record every new .env.example key in ENV_SINCE at `version`, so the env-history test cannot fail
 * on a variable that prepare.mjs did not know about. Idempotent.
 */
export function updateEnvHistory(root, version) {
  const path = join(root, 'apps/server/src/ops/env-history.ts');
  const source = read(path);
  const missing = missingEnvHistory(root);
  if (!missing.length) return [];
  const start = source.indexOf('export const ENV_SINCE: Record<string, string> = {');
  const end = source.indexOf('\n};', start);
  const block = missing.map((key) => `  ${key}: '${version}',`).join('\n');
  const insertion = `\n\n  // ${version} (added by scripts/release/prepare.mjs)\n${block}`;
  writeFileSync(path, source.slice(0, end) + insertion + source.slice(end));
  return missing;
}

/** The release section's body, or null when there is no such section. */
export function releaseSection(changelog, version) {
  return (
    splitSections(changelog)
      .sections.find((section) => section.version === version)
      ?.lines.join('\n') ?? null
  );
}

/** The `### Upgrading from …` block inside a section body. */
export function upgradeBlockOf(section) {
  const start = section.search(/^### Upgrading from /m);
  if (start < 0) return null;
  const rest = section.slice(start);
  const next = rest.slice(1).search(/^### /m);
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
}

/** The fields every release's upgrade block must carry, each with a non-empty value. */
export const UPGRADE_FIELDS = ['Migrations', 'Configuration', 'Breaking changes', 'Manual steps', 'Upgrade'];

/** Problems with one upgrade block: missing or empty fields, and an unfilled TODO. */
export function validateUpgradeBlock(block) {
  if (!block) return ['has no ### Upgrading from block'];
  const errors = [];
  if (/\bTODO\b/.test(block)) errors.push('still contains TODO; fill it in or write "none"');
  for (const field of UPGRADE_FIELDS) {
    const match = new RegExp(`^- \\*\\*${field}:\\*\\*[ \\t]*(.*)$`, 'm').exec(block);
    if (!match) errors.push(`is missing "- **${field}:**"`);
    else if (!match[1].trim()) errors.push(`has an empty "- **${field}:**"`);
  }
  return errors;
}

/** Problems that must be fixed before the release PR can merge. */
export function checkRelease({ root, version }) {
  const errors = [];
  const changelog = read(join(root, 'CHANGELOG.md'));
  const section = releaseSection(changelog, version);
  if (section === null) {
    errors.push(`CHANGELOG.md has no ## [${version}] section`);
  } else {
    for (const error of validateUpgradeBlock(upgradeBlockOf(section))) errors.push(`the ${version} section ${error}`);
  }
  const missing = missingEnvHistory(root);
  if (missing.length) errors.push(`ENV_SINCE is missing ${missing.join(', ')}; run prepare.mjs again or add them by hand`);
  const fragments = checkChangelog(join(root, 'changelog.d'));
  errors.push(...fragments.errors);
  return errors;
}

function runCheckVersions(root, version) {
  execFileSync(process.execPath, [join(root, 'scripts/check-versions.mjs'), version], { cwd: root, stdio: 'inherit' });
}

function parseArgs(argv) {
  const options = { version: undefined, date: undefined, previous: undefined, check: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--date') options.date = argv[++index];
    else if (arg === '--previous') options.previous = argv[++index];
    else if (arg === '--check') options.check = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else if (!options.version) options.version = arg.replace(/^v/, '');
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.version)
    throw new Error('usage: node scripts/release/prepare.mjs <version> [--date YYYY-MM-DD] [--previous <version>] [--check]');
  // The same SemVer 2.0.0 check as the workflow's prepare job (#671), so a hand run cannot accept
  // a version CI would refuse.
  const version = normalizeVersion(options.version);
  if (!version) throw new Error(`not a version: ${options.version}`);
  options.version = version;
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.check) {
      runCheckVersions(root, options.version);
      const errors = checkRelease({ root, version: options.version });
      if (errors.length) {
        for (const error of errors) console.error(`release check: ${error}`);
        process.exit(1);
      }
      console.log(`release check: ${options.version} is ready (version surfaces, upgrade block and ENV_SINCE)`);
    } else {
      const changelog = read(join(root, 'CHANGELOG.md'));
      const previous = options.previous ?? findPreviousVersion(changelog, options.version);
      if (!previous) throw new Error('cannot infer the previous release; pass --previous <version>');
      const migrations = migrationsSince(root, previous);
      const envVars = envVarsSince(root, previous);
      const upgradeBlock = renderUpgradeBlock({ previous, version: options.version, migrations, envVars });

      // Fold first (#602): a fragment validation failure must not leave version surfaces or
      // ENV_SINCE stamped with a version that never shipped, and the fold is retry-safe.
      const built = buildChangelog({
        version: options.version,
        date: options.date,
        dir: join(root, 'changelog.d'),
        changelogPath: join(root, 'CHANGELOG.md'),
        upgradeBlock,
      });
      const changes = bumpVersions(root, options.version);
      const added = updateEnvHistory(root, options.version);
      runCheckVersions(root, options.version);

      console.log(`prepared ${options.version} from ${previous}`);
      console.log(`  version surfaces: ${changes.length} files`);
      console.log(`  changelog: consumed ${built.consumed.length} fragment(s)`);
      console.log(`  migrations: ${migrations.length ? migrations.join(', ') : 'none'}`);
      console.log(`  configuration: ${envVars.length ? envVars.join(', ') : 'no new environment variables'}`);
      if (added.length) console.log(`  env history: added ${added.join(', ')} at ${options.version}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  1. Review the "### Upgrading from ${previous}" block in CHANGELOG.md and replace its TODO.`);
      console.log('  2. Commit the release changes and open the release pull request.');
      console.log('  3. Merge the pull request to main.');
      console.log(`  4. Dispatch the Release workflow from main with version ${options.version}, or push tag v${options.version}.`);
      console.log(`  5. After it publishes, run scripts/release/verify.sh ${options.version}.`);
      console.log(`  6. Close the issues GitHub left open with scripts/release/close-issues.mjs ${options.version} --yes.`);
    }
  } catch (error) {
    console.error(`prepare: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
