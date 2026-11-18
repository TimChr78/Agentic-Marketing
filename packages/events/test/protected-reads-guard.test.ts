import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTECTED_VIEWS, personReadSource, PERSON_TABLES as TABLES } from '../src/protected';

// #1037 part 2: read-time exclusion is only a contract if every reader goes through the protected
// views. A new query that names `events`, `message_events` or `journey_events` directly would
// silently return an erased person's rows again, so this guard fails the build unless the match is
// a maintenance statement.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SOURCE_ROOTS = ['packages', 'apps/server/src'];
const PERSON_TABLES = ['events', 'message_events', 'journey_events'] as const;

/** A read of a person table in SQL. Keywords are upper case by convention, which keeps prose such
 * as "From Events Manager" and "an agent from events" out of the scan. */
const READ = new RegExp(`\\b(?:FROM|JOIN)\\s+(${PERSON_TABLES.join('|')})\\b`, 'g');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'test', 'testdata', '.turbo'].includes(entry.name)) continue;
      out.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Every non-maintenance read of a person table in the application source, with its line. */
async function personTableReads(): Promise<{ file: string; line: number; text: string }[]> {
  const found: { file: string; line: number; text: string }[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of await sourceFiles(join(ROOT, root))) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      for (const [index, line] of lines.entries()) {
        // A comment may quote the SQL it explains; only real statements are scanned.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
        READ.lastIndex = 0;
        for (const match of line.matchAll(READ)) {
          // `DELETE FROM events` is the erasure sweep and the load-test reset, not a read. Any
          // other FROM/JOIN of a base table — a SELECT, a CTE, an INSERT … SELECT — bypasses the
          // protected view, so it must be a deliberate exception below.
          const before = line.slice(0, match.index ?? 0).trimEnd();
          if (/\bDELETE$/i.test(before)) continue;
          found.push({ file: relative(ROOT, path), line: index + 1, text: line.trim() });
        }
      }
    }
  }
  return found;
}

/**
 * Deliberate exceptions. Empty on purpose: every reader is routed through a protected view, and
 * a new one needs a reviewable line here rather than a silent bypass. A maintenance statement
 * (`DELETE FROM …`) does not need an entry: the sweep and the load-test reset are writers, not
 * readers, and the guard skips them by statement.
 */
const ALLOWED: { file: string; text: string; why: string }[] = [];

describe('protected reads (#1037 part 2)', () => {
  it('no application source reads a person-linked base table directly', async () => {
    const reads = await personTableReads();
    const offending = reads.filter((read) => !ALLOWED.some((entry) => entry.file === read.file && read.text.includes(entry.text)));
    expect(offending.map((read) => `${read.file}:${read.line}: ${read.text}`)).toEqual([]);
  });

  it('every protected view is created by the ClickHouse migrations and filters erased subjects', async () => {
    const source = await readFile(join(ROOT, 'packages/events/clickhouse/0009_protected_views.sql'), 'utf8');
    // Comments explain the shape; only the statements are checked.
    const migration = source.replace(/^\s*--.*$/gm, '');
    for (const table of PERSON_TABLES) {
      expect(migration).toContain(`CREATE VIEW IF NOT EXISTS ${table}_protected AS`);
      // The views are parameterized on the workspace, and the shared layer always supplies it.
      expect(personReadSource(table, true)).toBe(`${PROTECTED_VIEWS[table]}(ws={ws:UUID})`);
      expect(personReadSource(table, false)).toBe(table);
    }
    expect(TABLES).toEqual(PERSON_TABLES);
    // The exclusion state is the whole point of a view: one set subquery per view, keyed by the
    // caller's workspace parameter, and one array test over the row's subject keys.
    expect(migration.match(/FROM erased_subjects FINAL/g)).toHaveLength(PERSON_TABLES.length);
    expect(migration.match(/NOT arrayExists\(/g)).toHaveLength(PERSON_TABLES.length);
    // Both the ledger subquery and the backfill side read name the workspace, so each scan uses
    // its table's ordering prefix.
    expect(migration.match(/workspace_id = \{ws:UUID\}/g)).toHaveLength(PERSON_TABLES.length * 2);
    // Neither of the two shapes that failed a review: no per-row ledger array, no per-kind joins.
    expect(migration).not.toContain('groupUniqArray');
    expect(migration).not.toContain('LEFT ANTI JOIN');
    // FINAL belongs inside the view (it returns one logical row per replacing key). A caller that
    // added it again would merge the view's output, and one that relied on it would silently miss
    // both the dedupe and the exclusion.
    expect([...migration.matchAll(/FROM \w+_protected\b/gi)]).toHaveLength(0);
  });
});
