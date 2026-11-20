import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { createDisposableDb, hasTestDatabase } from './disposable';

// #1102: a merge that raced a list write could leave `segment_memberships` (and the list row) on
// the merged-away profile. Migration 0117 folds those stranded rows onto the chain's survivor
// through the same function a live merge uses, keeping the earliest addition and its provenance
// and collapsing a duplicate when the survivor was already on the list.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

const list = newId('seg');
const dynamic = newId('seg');
const survivor = newId('prf');
const middle = newId('prf');
const stranded = newId('prf');
const strandedListOnly = newId('prf');
const strandedDynamic = newId('prf');

// Fixed timestamps, so the assertions compare the values that were stored, never a fresh `Date`.
const strandedAt = new Date(Date.now() - 30 * 60_000);
const survivorAt = new Date(Date.now() - 5 * 60_000);
const listOnlyAt = new Date(Date.now() - 60_000);
const dynamicAt = new Date(Date.now() - 40 * 60_000);

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  // Up to the head before this migration, so the stranded rows exist when 0117 runs.
  d = await createDisposableDb('stranded_memberships', { upTo: '0113_erasure_completion.sql' });
  const ws = d.workspace;
  // A two-hop chain (stranded → middle → survivor), so the repair resolves a chain rather than a
  // single hop.
  await d.db.admin.query(
    `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
       ($1, $2, NULL),
       ($1, $3, $2),
       ($1, $4, $3),
       ($1, $5, $3),
       ($1, $6, $3)`,
    [ws, survivor, middle, stranded, strandedListOnly, strandedDynamic],
  );
  for (const [id, mode] of [
    [list, 'static'],
    [dynamic, 'dynamic'],
  ] as const) {
    await d.db.admin.query(
      `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
       VALUES ($1, $2, 'segment', $3, 1, 1)`,
      [ws, id, `Segment ${id.slice(-4)}`],
    );
    await d.db.admin.query(
      `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
       VALUES ($1, $2, 1, 'published', $3::jsonb, 'hash-0117', 'user', 'test')`,
      [
        ws,
        id,
        JSON.stringify(
          mode === 'static'
            ? { description: '', mode }
            : { description: '', mode, condition: { trait: 'city', op: 'eq', value: 'Aarhus' } },
        ),
      ],
    );
  }

  // The stranded list rows: added earlier than the survivor's, so the earliest addition must win.
  await d.db.admin.query(
    `INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, added_at, added_by, source)
     VALUES ($1, $2, $3, $4, 'usr_old', 'csv'),
            ($1, $2, $5, $6, 'usr_new', 'manual')`,
    [ws, list, stranded, strandedAt, survivor, survivorAt],
  );
  await d.db.admin.query(
    `INSERT INTO segment_memberships (workspace_id, segment_id, profile_id, since)
     VALUES ($1, $2, $3, $4),
            ($1, $2, $5, $6)`,
    [ws, list, stranded, strandedAt, survivor, survivorAt],
  );
  // A list row for a tombstone that has no materialised copy: the repair is driven by either table.
  await d.db.admin.query(
    `INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, added_at, added_by, source)
     VALUES ($1, $2, $3, $4, 'usr_old', 'api')`,
    [ws, list, strandedListOnly, listOnlyAt],
  );
  // A stranded dynamic membership is derived state, not list data: the repair must leave it alone
  // for the next refresh to recompute.
  await d.db.admin.query(`INSERT INTO segment_memberships (workspace_id, segment_id, profile_id, since) VALUES ($1, $2, $3, $4)`, [
    ws,
    dynamic,
    strandedDynamic,
    dynamicAt,
  ]);
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('stranded list rows on merged-away profiles (#1102)', () => {
  it('folds them onto the survivor, keeps the earliest addition, and updates segment_memberships', async () => {
    await migrate(d.db.admin, {
      appRole: 'am_ops_test_app',
      appRolePassword: 'am_ops_test_password',
    });
    const applied = await d.db.admin.query(`SELECT 1 FROM schema_migrations WHERE version = '0117_stranded_segment_memberships.sql'`);
    expect(applied.rowCount).toBe(1);

    const listRows = await d.db.admin.query<{ profile_id: string; added_at: Date; added_by: string | null; source: string }>(
      `SELECT profile_id, added_at, added_by, source FROM segment_list_members
        WHERE workspace_id = $1 AND segment_id = $2 ORDER BY profile_id`,
      [d.workspace, list],
    );
    // Both stranded list rows collapsed into the survivor's single row.
    expect(listRows.rows.map((r) => r.profile_id)).toEqual([survivor]);
    const survivorRow = listRows.rows[0]!;
    // The earlier stranded addition (and its provenance) wins over the survivor's later one.
    expect(survivorRow.added_by).toBe('usr_old');
    expect(survivorRow.source).toBe('csv');
    expect(survivorRow.added_at.getTime()).toBe(strandedAt.getTime());

    const memberships = await d.db.admin.query<{ profile_id: string; since: Date }>(
      `SELECT profile_id, since FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2 ORDER BY profile_id`,
      [d.workspace, list],
    );
    expect(memberships.rows.map((r) => r.profile_id)).toEqual([survivor]);
    expect(memberships.rows[0]?.since.getTime()).toBe(strandedAt.getTime());

    // The list row that had no materialised copy moved too; the repair did not depend on one table.
    const onlyList = await d.db.admin.query('SELECT 1 FROM segment_list_members WHERE workspace_id = $1 AND profile_id = $2', [
      d.workspace,
      strandedListOnly,
    ]);
    expect(onlyList.rowCount).toBe(0);

    // Dynamic membership is derived: it stays where it was.
    const dynamicRows = await d.db.admin.query<{ profile_id: string }>(
      `SELECT profile_id FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2`,
      [d.workspace, dynamic],
    );
    expect(dynamicRows.rows.map((r) => r.profile_id)).toEqual([strandedDynamic]);
  }, 180_000);
});
