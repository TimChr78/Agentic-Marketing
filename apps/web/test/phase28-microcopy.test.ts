import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 28 (#555) microcopy lint, report mode. It scans user-visible source strings for seeded raw
// ids, metric keys, purpose keys and the banned patterns in docs/design/phase-28/microcopy.md.
// Area tasks (W/M/A/C/S) own their current findings; this landing fails only for I-owned files.
// Each area flips its own section to strict when it adopts the lint. Exceptions are narrow:
// Identifier/code views and the label registry are technical affordances, not ordinary copy.
type Owner = 'I' | 'W' | 'M' | 'A' | 'C' | 'S';
type Finding = { file: string; owner: Owner; rule: string; line: number; text: string };

const ROOT = process.cwd().endsWith('apps/web') ? join(process.cwd(), '../..') : process.cwd();
const SRC = join(ROOT, 'apps/web/src');
const README = join(ROOT, 'docs/design/phase-28/README.md');
const EVIDENCE = join(ROOT, 'docs/design/phase-28/release-evidence.md');

/** The exact ownership lists in the contract README; area tasks are already disjoint. */
function ownership(): Map<string, Owner> {
  const source = readFileSync(README, 'utf8');
  const owners = new Map<string, Owner>();
  const sections = [...source.matchAll(/^### (I|W|M|A|C|S)\s*$/gm)];
  for (let i = 0; i < sections.length; i++) {
    const owner = sections[i][1] as Owner;
    const start = sections[i].index! + sections[i][0].length;
    const end = i + 1 < sections.length ? sections[i + 1].index! : source.length;
    for (const match of source.slice(start, end).matchAll(/^- `([^`]+)`/gm)) {
      const path = match[1];
      if (path.startsWith('apps/web/src/')) owners.set(path, owner);
    }
  }
  return owners;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:tsx?|jsx?)$/.test(name)) out.push(path);
  }
  return out;
}

const RULES: { rule: string; pattern: RegExp; why: string }[] = [
  { rule: 'raw-id', pattern: /\b(?:prf|agt|tok|jm|brd|cmp|seg|frm|tpl|blk|exp|prm|wsp)_[0-9a-z]{4,}/i, why: 'raw seeded id' },
  {
    rule: 'metric-key',
    pattern: /\bemail\.(?:sent|delivered|opened|clicked|click_rate|open_rate|bounce_rate|unsubscribe_rate|complaint_rate)\b/,
    why: 'metric key as a label',
  },
  { rule: 'purpose-key', pattern: /\b(?:web_personalization|marketing_email|transactional_email)\b/, why: 'purpose key as a label' },
  {
    rule: 'banned-copy',
    pattern: /\b(?:Oops|Something went wrong|successfully|simply|please wait|Loading…|Loading\.\.\.|it['’]s safe|it is safe)\b/i,
    why: 'banned copy',
  },
  { rule: 'no-data', pattern: /\bNo data\b(?!\s+(?:in|for|during|this|the)\b)/i, why: 'no-data verdict without scope' },
  {
    rule: 'generic-error',
    pattern: /^(?:Error|Loading|Working)$/,
    why: 'generic status without an object',
  },
];

/** Narrow allowlists: technical views and the friendly-name registry, with their reason. */
const ALLOW: { file: string; rule: string; reason: string }[] = [
  { file: 'apps/web/src/lib/labels.ts', rule: 'metric-key', reason: 'friendly-name registry key; the rendered label is separate' },
  { file: 'apps/web/src/lib/labels.ts', rule: 'purpose-key', reason: 'friendly-name registry key; the rendered label is separate' },
  { file: 'apps/web/src/ui/Identifier.tsx', rule: 'raw-id', reason: 'the existing technical copy affordance' },
  { file: 'apps/web/src/features/artifacts/JsonEditor.tsx', rule: 'raw-id', reason: 'explicit developer JSON view' },
  { file: 'apps/web/src/features/previews/previewSource.ts', rule: 'raw-id', reason: 'source parsing, not rendered copy' },
  {
    file: 'apps/web/src/features/phase27/demo/fixtures.ts',
    rule: 'purpose-key',
    reason: 'fixture technical values; the visible label comes from the friendly-name registry',
  },
  {
    file: 'apps/web/src/features/phase27/demo/fixtures.ts',
    rule: 'metric-key',
    reason: 'fixture technical values; charts and tiles render friendly metric labels',
  },
];

function allowed(file: string, rule: string): boolean {
  return ALLOW.some((a) => a.file === file && a.rule === rule);
}

/**
 * User-visible copy only: JSX text, a small set of visible attributes, and strings assigned to
 * copy-bearing properties or toast/error calls. Metric keys in queries (`measures: ['email.sent']`)
 * are technical values and must not be reported as labels.
 */
function visibleStrings(source: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  for (const match of source.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (text) out.push({ text, index: (match.index ?? 0) + 1 });
  }
  for (const match of source.matchAll(
    /\b(?:aria-label|aria-description|title|placeholder|alt|label|hint|description|summary|detail|note)=(["'])((?:(?!\1).)*)\1/g,
  )) {
    out.push({ text: match[2].trim(), index: match.index ?? 0 });
  }
  for (const match of source.matchAll(
    /\b(?:label|title|description|hint|text|message|body|empty|emptyTitle|emptyBody|placeholder|ariaLabel|summary|detail|note|copy|reason):\s*(['"`])((?:(?!\1).)*)\1/g,
  )) {
    out.push({ text: match[2].trim(), index: match.index ?? 0 });
  }
  for (const match of source.matchAll(
    /\b(?:toast\.(?:success|error|info)|setErr|setError|alert|confirm|throw new Error)\(\s*(['"`])((?:(?!\1).)*)\1/g,
  )) {
    out.push({ text: match[2].trim(), index: match.index ?? 0 });
  }
  return out.filter((entry) => entry.text.length > 0);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function scan(): Finding[] {
  const owners = ownership();
  const findings: Finding[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(ROOT, path).replaceAll('\\', '/');
    if (/\.test\.(?:ts|tsx)$/.test(file)) continue;
    const owner = owners.get(file);
    if (!owner) continue;
    const source = readFileSync(path, 'utf8');
    // Skip import/export declarations: they are module plumbing, never rendered copy.
    const scanSource = source.replace(/^(?:import|export)\s.*$/gm, '');
    for (const visible of visibleStrings(scanSource)) {
      for (const rule of RULES) {
        if (!rule.pattern.test(visible.text)) continue;
        if (allowed(file, rule.rule)) continue;
        findings.push({ file, owner, rule: rule.rule, line: lineOf(scanSource, visible.index), text: visible.text.slice(0, 120) });
        break;
      }
    }
  }
  return findings;
}

function report(findings: Finding[]): string {
  const owners: Owner[] = ['I', 'W', 'M', 'A', 'C', 'S'];
  const lines = ['<!-- phase28-microcopy:start -->'];
  for (const owner of owners) {
    const rows = findings.filter((f) => f.owner === owner);
    lines.push(`### ${owner} · ${rows.length} finding${rows.length === 1 ? '' : 's'}`);
    lines.push('');
    if (!rows.length) lines.push('None.');
    for (const row of rows.slice(0, 80)) lines.push(`- \`${row.file}:${row.line}\` **${row.rule}** — ${row.text}`);
    if (rows.length > 80) lines.push(`- … ${rows.length - 80} more`);
    lines.push('');
  }
  lines.push('<!-- phase28-microcopy:end -->');
  return `${lines.join('\n')}\n`;
}

function writeEvidence(section: string) {
  const start = '<!-- phase28-microcopy:start -->';
  const end = '<!-- phase28-microcopy:end -->';
  let current = '';
  try {
    current = readFileSync(EVIDENCE, 'utf8');
  } catch {
    current = '# Phase 28 release evidence\n';
  }
  const next = current.includes(start)
    ? `${current.slice(0, current.indexOf(start))}${section}${current.slice(current.indexOf(end) + end.length).replace(/^\n/, '')}`
    : `${current.trimEnd()}\n\n## Microcopy lint\n\n${section}`;
  writeFileSync(EVIDENCE, next.endsWith('\n') ? next : `${next}\n`);
}

describe('phase 28 microcopy lint (#555)', () => {
  const findings = scan();

  it('writes the current findings, grouped by owning task, to release-evidence.md', () => {
    writeEvidence(report(findings));
    expect(readFileSync(EVIDENCE, 'utf8')).toContain('phase28-microcopy:start');
  });

  it('I-owned shared copy has no raw ids, keys or banned patterns', () => {
    const ours = findings.filter((f) => f.owner === 'I');
    const detail = ours.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`).join('\n');
    expect(ours, detail).toEqual([]);
  });

  it('reports the area totals so each task can flip its own section to strict', () => {
    for (const owner of ['W', 'M', 'A', 'C', 'S'] as const) {
      const rows = findings.filter((f) => f.owner === owner);
      console.log(`${owner}: ${rows.length} microcopy finding${rows.length === 1 ? '' : 's'}`);
    }
    expect(findings.length).toBeGreaterThanOrEqual(0);
  });
});
