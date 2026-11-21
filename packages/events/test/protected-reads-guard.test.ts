import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTECTED_VIEWS, personReadSource, PERSON_TABLES as TABLES } from '../src/protected';
import { SUBJECT_KEY_BACKFILL_TABLES } from '../src/subjectKeys';

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

/**
 * Files allowed to interpolate a `FROM`/`JOIN` source whose value is not a person table. Each entry
 * names where the variable comes from; a new one needs the same care as a literal base-table read.
 */
const INTERPOLATED_ALLOWED: { file: string; expression: string; why: string }[] = [
  { file: 'packages/analytics/src/compile.ts', expression: 'from', why: 'built by personReadSource / messageEventsWithPending' },
  { file: 'packages/events/src/clickhouse.ts', expression: 'source', why: 'built by personReadSource in the same function' },
  { file: 'packages/events/src/clickhouse.ts', expression: 'spec.table', why: 'subject-key backfill reads the table it is filling' },
  { file: 'packages/events/src/pending.ts', expression: 'published', why: 'built by personReadSource' },
  { file: 'packages/analytics/src/query.ts', expression: 'table', why: 'built by personReadSource' },
  { file: 'packages/warehouse/src/datasets.ts', expression: 'source', why: 'built by personReadSource' },
];

/** A `FROM`/`JOIN` whose table is interpolated, with the expression it interpolates. */
const INTERPOLATED = /\b(?:FROM|JOIN)\s+\$\{([^}]+)\}/g;

/** Interpolated `FROM`/`JOIN` sources that are neither a person-source helper nor allow-listed. */
async function interpolatedSources(): Promise<{ file: string; line: number; expression: string }[]> {
  const found: { file: string; line: number; expression: string }[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of await sourceFiles(join(ROOT, root))) {
      const file = relative(ROOT, path);
      const source = await readFile(path, 'utf8');
      // Only the person-read layer can hold a person-table interpolation; the rest of the tree has
      // its own SQL (CTEs, warehouse schemas) that this guard is not about.
      if (!/personReadSource|messageEventsWithPending|PROTECTED_VIEWS/.test(source)) continue;
      for (const [index, line] of source.split('\n').entries()) {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
        for (const match of line.matchAll(INTERPOLATED)) {
          // `DELETE FROM ${table}` is the erasure sweep, a writer, not a read.
          if (/\bDELETE$/i.test(line.slice(0, match.index ?? 0).trimEnd())) continue;
          const expression = match[1]!.trim();
          if (/^personReadSource\(/.test(expression)) continue;
          if (INTERPOLATED_ALLOWED.some((entry) => entry.file === file && entry.expression === expression)) continue;
          found.push({ file, line: index + 1, expression });
        }
      }
    }
  }
  return found;
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
const ALLOWED: { file: string; text: string; why: string }[] = [
  {
    file: 'packages/events/src/pending.ts',
    text: 'FROM message_events FINAL',
    // The pending union's dedupe key set: identity columns only, never returned to a reader.
    why: 'pending-outbox anti-join',
  },
  {
    file: 'packages/events/src/clickhouse.ts',
    text: 'FROM message_events AS m FINAL',
    // The id-scoped message-event read (#1037 part 2): its own exclusion predicate follows in the
    // same statement, bounded to the keys the scope can carry.
    why: 'id-scoped message read',
  },
  {
    file: 'packages/events/src/clickhouse.ts',
    text: 'FROM message_events AS sm FINAL',
    // The bound of that predicate (#1195): the same scope read inside the same statement, so a row
    // committed after the width probe is still excluded by the counting query itself.
    why: 'id-scoped message read bound',
  },
];

describe('protected reads (#1037 part 2)', () => {
  it('no application source reads a person-linked base table directly', async () => {
    const reads = await personTableReads();
    const offending = reads.filter((read) => !ALLOWED.some((entry) => entry.file === read.file && read.text.includes(entry.text)));
    expect(offending.map((read) => `${read.file}:${read.line}: ${read.text}`)).toEqual([]);
  });

  it('no interpolated FROM/JOIN source is a person table outside the allow-list', async () => {
    // A base table can also arrive through a variable; a new one must be a helper call or listed
    // above, so a bypass is reviewable rather than invisible to the literal scan.
    expect((await interpolatedSources()).map((entry) => `${entry.file}:${entry.line}: ${entry.expression}`)).toEqual([]);
  });

  it('message events carry only the profile subject key', async () => {
    // The id-scoped message read tests only the profile key, because `message_events` has no other
    // subject source: its writer hashes the profile alone and the backfill spec names only that
    // column. If either grows another kind, the bounded read would under-exclude silently, so a
    // change must update the read with it.
    const backfill = SUBJECT_KEY_BACKFILL_TABLES.find((spec) => spec.table === 'message_events');
    expect(backfill?.sources.map((source) => source.kind)).toEqual(['profile']);
    expect(backfill?.clickIds).toBe(false);

    const sources: { path: string; text: string }[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const path of await sourceFiles(join(ROOT, root))) {
        sources.push({ path: relative(ROOT, path), text: await readFile(path, 'utf8') });
      }
    }
    // One writer: the shutdown-safe insert that hashes `profileSubjectSources`. A second one would
    // need the same guard, and the count is what makes it reviewable.
    // `client.insert({ … table: 'message_events' … })` is the writer; the backfill spec's table
    // name is not an insert.
    const writers = sources.filter((source) => /client\.insert\(\{[\s\S]{0,400}?table:\s*'message_events'/.test(source.text));
    expect(writers.map((writer) => writer.path)).toEqual(['packages/events/src/clickhouse.ts']);
    expect(writers[0]!.text).toMatch(/profileSubjectSources/);
    const messageEventBackfill = sources.find((source) => source.path === 'packages/events/src/subjectKeys.ts');
    expect(messageEventBackfill!.text).toMatch(/sources:\s*\[\{ kind: 'profile', column: 'profile_id' \}\]/);
  });

  it('every protected view is created by the ClickHouse migrations and filters erased subjects', async () => {
    const [created, latest] = await Promise.all(
      ['0009_protected_views.sql', '0010_protected_views_fail_closed.sql'].map(async (file) =>
        // Comments explain the shape; only the statements are checked.
        (await readFile(join(ROOT, 'packages/events/clickhouse', file), 'utf8')).replace(/^\s*--.*$/gm, ''),
      ),
    );
    for (const table of PERSON_TABLES) {
      expect(created).toContain(`CREATE VIEW IF NOT EXISTS ${table}_protected AS`);
      expect(latest).toContain(`CREATE VIEW ${table}_protected AS`);
      // The views are parameterized on the workspace, and the shared layer always supplies it.
      expect(personReadSource(table, true)).toBe(`${PROTECTED_VIEWS[table]}(ws={ws:UUID})`);
      expect(personReadSource(table, false)).toBe(table);
    }
    expect(TABLES).toEqual(PERSON_TABLES);
    // The exclusion state is the whole point of a view: one set subquery per view, keyed by the
    // caller's workspace parameter, and one array test over the row's subject keys.
    expect(created.match(/FROM erased_subjects FINAL/g)).toHaveLength(PERSON_TABLES.length);
    expect(created.match(/NOT arrayExists\(/g)).toHaveLength(PERSON_TABLES.length);
    // Both the ledger subquery and the backfill side read name the workspace, so each scan uses
    // its table's ordering prefix.
    expect(created.match(/workspace_id = \{ws:UUID\}/g)).toHaveLength(PERSON_TABLES.length * 2);
    // The fail-closed successor adds, per view, a one-row existence check for the workspace's
    // published exclusions (#1195): uncovered rows are hidden only once there is something to
    // exclude, so a workspace whose publication is still pending keeps its legacy rows readable
    // for the same window in which the erased subject itself is still readable.
    expect(latest.match(/FROM erased_subjects FINAL/g)).toHaveLength(PERSON_TABLES.length * 2);
    expect(latest.match(/NOT arrayExists\(/g)).toHaveLength(PERSON_TABLES.length);
    expect(latest.match(/workspace_id = \{ws:UUID\}/g)).toHaveLength(PERSON_TABLES.length * 3);
    for (const migration of [created, latest]) {
      // Neither of the two shapes that failed a review: no per-row ledger array, no per-kind joins.
      expect(migration).not.toContain('groupUniqArray');
      expect(migration).not.toContain('LEFT ANTI JOIN');
      // FINAL belongs inside the view (it returns one logical row per replacing key). A caller that
      // added it again would merge the view's output, and one that relied on it would silently miss
      // both the dedupe and the exclusion.
      expect([...migration.matchAll(/FROM \w+_protected\b/gi)]).toHaveLength(0);
    }
    // #1195: a row that is neither complete nor backfilled is unverified, not visible by default.
    expect(latest.match(/1 AS side_found/g)).toHaveLength(PERSON_TABLES.length);
    expect(latest.match(/OR NOT EXISTS \(SELECT 1 FROM erased_subjects FINAL/g)).toHaveLength(PERSON_TABLES.length);
  });
});
