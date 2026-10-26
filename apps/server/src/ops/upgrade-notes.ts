import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { VERSION } from '../version';

// `am upgrade-notes <from> [--to <version>]`: the upgrade blocks of every release between two
// versions, merged, so skipping releases does not mean reading and merging release notes by hand
// (#135). Reads CHANGELOG.md, which ships in the image and in the Compose bundle.

const USAGE = `usage: am upgrade-notes <from-version> [--to <version>] [--changelog PATH] [--json]

Merges the "Upgrading from" blocks of every release after <from-version> up to --to (default: this
version, ${VERSION}): all migrations, configuration changes, breaking changes and manual steps, then
the one-line upgrade of the newest release.`;

/** The five lines every release's upgrade block has since 0.2.4. */
export const LABELS = ['Migrations', 'Configuration', 'Breaking changes', 'Manual steps', 'Upgrade'] as const;
type Label = (typeof LABELS)[number];

export interface ReleaseNotes {
  version: string;
  /** The heading's "from" version, e.g. 0.2.3 in "### Upgrading from 0.2.3". */
  from: string | null;
  /** The labelled lines, when the block has the fixed shape. */
  fields: Partial<Record<Label, string>>;
  /** The whole block, for releases before the fixed shape. */
  text: string;
}

const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Every released version's upgrade block, oldest first. */
export function parseChangelog(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = [];
  for (const section of markdown.split(/^## /m).slice(1)) {
    const version = /^\[(\d+\.\d+\.\d+[^\]]*)\]/.exec(section)?.[1];
    if (!version) continue; // Unreleased
    const block = /^### Upgrading from ([^\n]*)\n([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(section);
    if (!block) {
      releases.push({ version, from: null, fields: {}, text: '' });
      continue;
    }
    const text = block[2].trim();
    const fields: Partial<Record<Label, string>> = {};
    // A labelled line and its indented continuation lines, up to the next top-level bullet.
    for (const m of text.matchAll(/^- \*\*([^*]+):\*\*([\s\S]*?)(?=^- \*\*|(?![\s\S]))/gm)) {
      const label = LABELS.find((l) => l === m[1].trim());
      if (label) fields[label] = m[2].trim();
    }
    releases.push({ version, from: block[1].trim(), fields, text });
  }
  return releases.sort((a, b) => compareVersions(a.version, b.version));
}

/** The merged notes for an upgrade from `from` to `to`, as text. */
export function mergeUpgradeNotes(releases: ReleaseNotes[], from: string, to: string): string {
  const between = releases.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0);
  if (!between.length) return `Nothing to do: ${to} is not newer than ${from}.`;
  const shaped = between.filter((r) => LABELS.every((l) => r.fields[l] !== undefined));
  const freeForm = between.filter((r) => !shaped.includes(r));
  const indent = (s: string) => s.replace(/\n/g, '\n  ');
  const out = [`Upgrading from ${from} to ${to}: ${between.map((r) => r.version).join(', ')}.`, ''];
  if (freeForm.length) {
    out.push(
      `Read these releases' notes in full first (they predate the fixed upgrade block): ${freeForm.map((r) => r.version).join(', ')}.`,
      'Any migration in them runs too, and the app takes its pre-upgrade backup when one is pending.',
      '',
    );
  }
  for (const label of LABELS.slice(0, 4)) {
    out.push(`${label}:`);
    for (const r of shaped) {
      const value = r.fields[label] ?? '';
      // A field that is itself a list goes under its version, not after it on one line.
      out.push(
        value.startsWith('- ') ? `- ${r.version}:\n  ${indent(value.replace(/\n {2}/g, '\n'))}` : `- ${r.version}: ${indent(value)}`,
      );
    }
    out.push('');
  }
  for (const r of freeForm)
    out.push(`${r.version} (upgrading from ${r.from ?? 'the previous release'}):`, `  ${indent(r.text || 'no upgrade notes')}`, '');
  const newest = between.at(-1)!;
  out.push(`Upgrade (${newest.version}):`, `  ${indent(newest.fields.Upgrade ?? 'see the release notes above')}`);
  return out.join('\n');
}

function changelogPath(given?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = given ? [resolve(process.env.INIT_CWD ?? process.cwd(), given)] : [resolve(here, '../../../../CHANGELOG.md')];
  return candidates.find((p) => existsSync(p));
}

const parse = (args: string[]) =>
  parseArgs({
    args,
    options: { to: { type: 'string' }, changelog: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
  });

export async function run(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (err) {
    console.error(`am upgrade-notes: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const from = positionals[0];
  if (!from || !/^v?\d+\.\d+\.\d+/.test(from)) {
    console.error(USAGE);
    return 2;
  }
  const path = changelogPath(values.changelog);
  if (!path) {
    console.error('am upgrade-notes: CHANGELOG.md not found (pass --changelog PATH)');
    return 1;
  }
  const releases = parseChangelog(readFileSync(path, 'utf8'));
  const to = values.to ?? VERSION;
  if (values.json) {
    const between = releases.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0);
    console.log(JSON.stringify({ from, to, releases: between }, null, 2));
  } else console.log(mergeUpgradeNotes(releases, from, to));
  return 0;
}
