import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../db/src/migrate';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';

// #912: exactly one published version per artifact is a database constraint, not only the publish
// lock's discipline. The migration resolves artifacts that already have more than one, then the
// partial unique index refuses a second published row.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

let nextId = 1;
const id = (prefix: string) => `${prefix}_${(nextId++).toString(16).padStart(32, '0')}`;

describe.skipIf(!hasTestDatabase())('one published version migration (#912)', () => {
  it('keeps the pointed-at version (else the highest), supersedes the rest, and creates the index', async () => {
    const d = await createDisposableDb('published', { upTo: '0092_singleton_artifacts.sql' });
    open.push(d);
    const ws = d.workspace;

    const artifact = async (published: number | null) => {
      const artifactId = id('not');
      await d.db.admin.query(
        `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
         VALUES ($1, $2, 'note', 'Seed note', 1, $3)`,
        [ws, artifactId, published],
      );
      return artifactId;
    };
    const version = async (artifactId: string, number: number, state: string) =>
      d.db.admin.query(
        `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, 'user', 'usr_seed')`,
        [ws, artifactId, number, state, `hash-${artifactId}-${number}`],
      );

    // Two published versions, the pointer names v2: v2 stays, v3 is superseded.
    const pointedAt = await artifact(2);
    for (const n of [1, 2, 3]) await version(pointedAt, n, 'published');
    // Two published versions and no pointer: the highest (v2) stays and the pointer is set to it.
    const noPointer = await artifact(null);
    for (const n of [1, 2]) await version(noPointer, n, 'published');
    // Two published versions, the pointer names a draft v3: v2 stays and the pointer moves to it.
    const stalePointer = await artifact(3);
    await version(stalePointer, 1, 'published');
    await version(stalePointer, 2, 'published');
    await version(stalePointer, 3, 'draft');
    // A healthy artifact is left alone.
    await version(await artifact(1), 1, 'published');
    // One published version plus a draft is untouched too.
    const healthyDraft = await artifact(1);
    await version(healthyDraft, 1, 'published');
    await version(healthyDraft, 2, 'draft');

    await migrate(d.db.admin, APP_ROLE);

    const stateOf = async (artifactId: string) => {
      const { rows } = await d.db.admin.query<{ number: number; state: string }>(
        'SELECT number, state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number',
        [ws, artifactId],
      );
      return Object.fromEntries(rows.map((r) => [r.number, r.state]));
    };
    const pointerOf = async (artifactId: string) =>
      (
        await d.db.admin.query<{ published_version: number | null }>(
          'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
          [ws, artifactId],
        )
      ).rows[0]?.published_version;

    expect(await stateOf(pointedAt)).toEqual({ 1: 'superseded', 2: 'published', 3: 'superseded' });
    expect(await pointerOf(pointedAt)).toBe(2);
    expect(await stateOf(noPointer)).toEqual({ 1: 'superseded', 2: 'published' });
    expect(await pointerOf(noPointer)).toBe(2);
    expect(await stateOf(stalePointer)).toEqual({ 1: 'superseded', 2: 'published', 3: 'draft' });
    expect(await pointerOf(stalePointer)).toBe(2);
    expect(await stateOf(healthyDraft)).toEqual({ 1: 'published', 2: 'draft' });
    expect(await pointerOf(healthyDraft)).toBe(1);

    // The partial unique index exists, is valid, and is limited to published versions.
    const { rows: indexes } = await d.db.admin.query<{ indexdef: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'artifact_versions_one_published'`,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.valid).toBe(true);
    expect(indexes[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(indexes[0]?.indexdef).toMatch(/workspace_id, artifact_id/);
    expect(indexes[0]?.indexdef).toMatch(/state = 'published'/);

    // A second published version is refused, by insert and by update; superseding the live one
    // first frees the slot, which is the order `publishVersion` writes in.
    await expect(version(healthyDraft, 3, 'published')).rejects.toMatchObject({ code: '23505' });
    await expect(
      d.db.admin.query("UPDATE artifact_versions SET state = 'published' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 2", [
        ws,
        healthyDraft,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await d.db.admin.query(
      "UPDATE artifact_versions SET state = 'superseded' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1",
      [ws, healthyDraft],
    );
    await version(healthyDraft, 3, 'published');
    expect(await stateOf(healthyDraft)).toEqual({ 1: 'superseded', 2: 'draft', 3: 'published' });
  }, 120_000);
});
