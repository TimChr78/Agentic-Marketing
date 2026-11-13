import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../db/src/migrate';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { type ArtifactType, artifactTypes, SINGLETON_TYPES } from '../src/types';

// #869: one artifact per workspace for the singleton types is a database constraint, not only an
// application check. The migration resolves existing duplicates before it creates the partial
// unique index, and the index predicate must list exactly the types the registry marks singleton.

/** The registry's own singleton list, derived independently of SINGLETON_TYPES so drift fails. */
const registrySingletons = (Object.keys(artifactTypes) as ArtifactType[]).filter((type) => 'singleton' in artifactTypes[type]).sort();

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

let nextId = 1;
const id = (prefix: string) => `${prefix}_${(nextId++).toString(16).padStart(32, '0')}`;

describe.skipIf(!hasTestDatabase())('singleton uniqueness migration (#869)', () => {
  it('keeps the published row (or the oldest), archives the rest, and creates the index', async () => {
    const d = await createDisposableDb('singleton', { upTo: '0090_suppressions_update_grant.sql' });
    open.push(d);
    const ws = d.workspace;

    // Seed duplicates as they exist after an import or a create race. `published` wins over an
    // older draft; among published rows the oldest is kept; with no published row, the oldest wins.
    const ids = {
      oldDraftBrand: id('brd'),
      olderPublishedBrand: id('brd'),
      newerPublishedBrand: id('brd'),
      newestPlan: id('tpl'),
      oldestPlan: id('tpl'),
      publishedPurposes: id('pur'),
      olderDraftPurposes: id('pur'),
      newerMap: id('cvm'),
      olderMap: id('cvm'),
      onlyPolicy: id('dlp'),
    };
    const seed: { id: string; type: string; name: string; published: number | null; ageDays: number }[] = [
      { id: ids.oldDraftBrand, type: 'brand', name: 'Old draft brand', published: null, ageDays: 3 },
      { id: ids.olderPublishedBrand, type: 'brand', name: 'Published brand', published: 1, ageDays: 4 },
      { id: ids.newerPublishedBrand, type: 'brand', name: 'Second published brand', published: 1, ageDays: 1 },
      { id: ids.newestPlan, type: 'tracking_plan', name: 'Newest plan', published: null, ageDays: 1 },
      { id: ids.oldestPlan, type: 'tracking_plan', name: 'Oldest plan', published: null, ageDays: 5 },
      { id: ids.publishedPurposes, type: 'purposes', name: 'Published purposes', published: 2, ageDays: 2 },
      { id: ids.olderDraftPurposes, type: 'purposes', name: 'Older draft purposes', published: null, ageDays: 6 },
      { id: ids.newerMap, type: 'conversion_map', name: 'Newer map', published: 1, ageDays: 2 },
      { id: ids.olderMap, type: 'conversion_map', name: 'Older map', published: 2, ageDays: 3 },
      { id: ids.onlyPolicy, type: 'delivery_policy', name: 'Only policy', published: null, ageDays: 1 },
    ];
    for (const row of seed)
      await d.db.admin.query(
        `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, now() - ($6 || ' days')::interval, now())`,
        [ws, row.id, row.type, row.name, row.published, row.ageDays],
      );

    await migrate(d.db.admin, APP_ROLE);

    const kept = new Map([
      ['brand', ids.olderPublishedBrand],
      ['tracking_plan', ids.oldestPlan],
      ['purposes', ids.publishedPurposes],
      ['conversion_map', ids.olderMap],
      ['delivery_policy', ids.onlyPolicy],
    ]);
    for (const [type, expected] of kept) {
      const { rows } = await d.db.admin.query<{ id: string; archived: boolean; name: string }>(
        'SELECT id, archived, name FROM artifacts WHERE workspace_id = $1 AND type = $2 ORDER BY id',
        [ws, type],
      );
      expect(rows.find((r) => r.id === expected)).toMatchObject({ archived: false });
      for (const other of rows.filter((r) => r.id !== expected)) {
        expect(other.archived, `${other.id} should be archived`).toBe(true);
        expect(other.name).toContain('archived duplicate');
      }
    }

    // The partial unique index exists, is valid, and lists exactly the registry's singletons.
    const { rows: indexes } = await d.db.admin.query<{ indexdef: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'artifacts_singleton_type'`,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.valid).toBe(true);
    expect(indexes[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(indexes[0]?.indexdef).toMatch(/archived = false/);
    const indexed = [...(indexes[0]?.indexdef.matchAll(/'([a-z_]+)'::text/g) ?? [])].map((m) => m[1]).sort();
    expect(indexed).toEqual(registrySingletons);
    expect([...SINGLETON_TYPES].sort()).toEqual(registrySingletons);

    // The index refuses a new duplicate of a kept singleton, and archiving the live row frees the
    // slot (archived duplicates are history, not live configuration).
    await expect(
      d.db.admin.query(`INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'brand', 'New brand', 1)`, [
        ws,
        id('brd'),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await d.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, ids.olderPublishedBrand]);
    await d.db.admin.query(
      `INSERT INTO artifacts (workspace_id, id, type, name, latest_version) VALUES ($1, $2, 'brand', 'New brand', 1)`,
      [ws, id('brd')],
    );
  }, 120_000);
});
