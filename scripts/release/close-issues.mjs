#!/usr/bin/env node
// Close the issues a release fixed (#521). GitHub closes `Closes #…` issues when a pull request
// merges, but a release can cover issues merged earlier, fragment-only issues, and issues GitHub
// left open. This collects both sources, comments with the release link and closes the open ones.
//
//   node scripts/release/close-issues.mjs <version>            # dry run (the default)
//   node scripts/release/close-issues.mjs <version> --yes      # comment and close
//
// The repository comes from GITHUB_REPOSITORY or `gh repo view`.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseSection } from './prepare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Issue numbers in `Closes #1, #2` / `Fixes #3` / `Resolves #4` lines. */
export function parseCloses(body) {
  const issues = new Set();
  for (const match of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:#\d+[\s,;]*)+)/gi)) {
    for (const number of match[1].matchAll(/#(\d+)/g)) issues.add(Number(number[1]));
  }
  return [...issues].sort((a, b) => a - b);
}

/** The `<!-- issues: 1, 2 -->` marker that changelog.mjs writes into a built section. */
export function parseIssuesComment(section) {
  const match = /<!--\s*issues:\s*([\d,\s]+)\s*-->/.exec(section ?? '');
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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
}

function parseArgs(argv) {
  const options = { version: undefined, yes: false, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else if (!options.version) options.version = arg.replace(/^v/, '');
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.version) throw new Error('usage: node scripts/release/close-issues.mjs <version> [--dry-run] [--yes]');
  return options;
}

/** The merged pull requests that belong to a release, by tag range and default branch. */
export function selectReleasePullRequests({ prs, commits, defaultBranch }) {
  const range = new Set(commits);
  return prs.filter((pr) => pr.baseRefName === defaultBranch && pr.mergeCommit?.oid && range.has(pr.mergeCommit.oid));
}

/** Issues named by the selected pull requests and by the release section's fragment marker. */
export function issuesForRelease({ prs, changelog, version }) {
  const section = version ? releaseSection(changelog, version) : changelog;
  const issues = new Set();
  for (const pr of prs) for (const issue of parseCloses(pr.body ?? '')) issues.add(issue);
  for (const issue of parseIssuesComment(section ?? '')) issues.add(issue);
  return [...issues].sort((a, b) => a - b);
}

/** The CHANGELOG.md at the release tag, not the checkout, so a later edit cannot change the result. */
export function readChangelogAtTag(version, run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })) {
  return run(['show', `v${version}:CHANGELOG.md`]);
}

function defaultBranch(repo) {
  return gh(['api', `repos/${repo}`, '--jq', '.default_branch']);
}

/** The release immediately before `version`, or null for the first release. */
function previousTag(repo, version) {
  const releases = JSON.parse(gh(['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName,publishedAt']));
  const index = releases.findIndex((release) => release.tagName === `v${version}`);
  return index >= 0 ? (releases[index + 1]?.tagName ?? null) : null;
}

/** Commit SHAs in v<previous>..v<version>, or the tag's history for the first release. */
function commitsInRange(previous, version) {
  const range = previous ? `${previous}..v${version}` : `v${version}`;
  return execFileSync('git', ['rev-list', range], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const dryRun = !options.yes || options.dryRun;
    const repo = repository();
    const release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/v${options.version}`]));
    const branch = defaultBranch(repo);
    const previous = previousTag(repo, options.version);
    const commits = commitsInRange(previous, options.version);
    const prs = JSON.parse(
      gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '500', '--json', 'number,body,baseRefName,mergeCommit']),
    );
    const selected = selectReleasePullRequests({ prs, commits, defaultBranch: branch });
    const changelog = readChangelogAtTag(options.version);
    const sorted = issuesForRelease({ prs: selected, changelog, version: options.version });

    console.log(
      `close-issues: v${options.version} has ${selected.length} merged pull request(s) on ${branch} and ${sorted.length} issue(s)`,
    );
    if (!sorted.length) {
      console.log('close-issues: nothing to close');
      process.exit(0);
    }

    let acted = 0;
    for (const issue of sorted) {
      const state = gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'state', '-q', '.state']);
      if (state !== 'OPEN') {
        console.log(`  #${issue}: already ${state.toLowerCase()}`);
        continue;
      }
      if (dryRun) {
        console.log(`  #${issue}: would comment and close (dry run)`);
        continue;
      }
      gh(['issue', 'comment', String(issue), '--repo', repo, '--body', `Released in v${options.version}: ${release.html_url}`]);
      gh(['issue', 'close', String(issue), '--repo', repo]);
      acted++;
      console.log(`  #${issue}: commented and closed`);
    }
    console.log(dryRun ? 'close-issues: dry run; pass --yes to act' : `close-issues: closed ${acted} issue(s)`);
  } catch (error) {
    console.error(`close-issues: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
