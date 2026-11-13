import { type ArtifactType, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand, userPrincipal } from '@agentic-marketing/commands';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rejects, startTestServer, testPort, type User } from './harness';

// #869: one artifact per workspace for the singleton types is a database constraint, not only an
// application check. A bundle with two entries of one type is refused; a concurrent create race
// answers conflict instead of a raw unique violation. The migration test lives in
// packages/artifacts/test/singleton-index.test.ts.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01417_869', testPort(4452));
  owner = await t.signUp(`owner-v01417-869-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const bundleOf = (artifacts: { id: string; type: ArtifactType; name: string; content: unknown }[]) => ({
  format: 'agentic-marketing/artifacts@1' as const,
  artifacts,
});

const publishedBrand = (ws: string) => t.srv.db.withWorkspace(ws, (tx) => publishedSingleton(tx, 'brand'));

const archive = (ws: string, id: string) =>
  t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, id]);

const archivedDuplicate = async (ws: string) => {
  const id = newId('brd');
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, archived)
     VALUES ($1, $2, 'brand', 'Duplicate brand (archived duplicate)', 1, true)`,
    [ws, id],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions
       (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'draft', $3, 'archived-duplicate-hash', 'user', $4)`,
    [ws, id, { siteName: 'Archived duplicate' }, owner.id],
  );
  return id;
};

/** A command that forces the singleton partial unique index, so the executor's mapping is tested. */
const forceSingletonConflict = defineCommand({
  name: 'test.forceSingletonConflict',
  title: 'Force a singleton conflict',
  description: 'Test-only command: insert a second brand and hit the singleton partial unique index.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async (_input, ctx) => {
    await ctx.tx.insert(schema.artifacts).values({
      workspaceId: ctx.principal.workspaceId,
      id: newId('brd'),
      type: 'brand',
      name: 'Second brand',
      latestVersion: 1,
    });
    return { ok: true };
  },
});

describe('singleton artifacts stay unique (#869)', () => {
  it('refuses two entries of one singleton type in a bundle', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const bundle = bundleOf([
      { id: `brd_${'a'.repeat(32)}`, type: 'brand', name: 'Brand A', content: { siteName: 'Brand A' } },
      { id: `brd_${'b'.repeat(32)}`, type: 'brand', name: 'Brand B', content: { siteName: 'Brand B' } },
    ]);
    const err = await rejects(api.call('config.import', { bundle, dryRun: false }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toMatch(/only one brand/i);
    const count = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM artifacts WHERE workspace_id = $1 AND type = 'brand'",
      [ws],
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('turns a concurrent create race into a conflict, not a unique violation', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const results = await Promise.allSettled([
      api.call('artifacts.create', { type: 'brand', name: 'Racing brand', content: { siteName: 'First' } }),
      api.call('artifacts.create', { type: 'brand', name: 'Racing brand', content: { siteName: 'Second' } }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as { code: string; message: string };
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/one brand/i);
    const rows = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM artifacts WHERE workspace_id = $1 AND type = 'brand'",
      [ws],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('import publishes the active singleton, never an archived brand', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const archived = await api.call('artifacts.create', { type: 'brand', name: 'Old brand', content: { siteName: 'Old' } });
    await archive(ws, archived.artifactId);
    const importedId = newId('brd');

    const out = await api.call('config.import', {
      bundle: bundleOf([{ id: importedId, type: 'brand', name: 'Current brand', content: { siteName: 'Current' } }]),
      dryRun: false,
      publish: true,
    });

    expect(out.changes).toMatchObject([{ id: importedId, type: 'brand', action: 'create', publish: 'published' }]);
    expect((await publishedBrand(ws))?.siteName).toBe('Current');
    const rows = await t.srv.db.admin.query<{ id: string; archived: boolean; name: string; published_version: number | null }>(
      'SELECT id, archived, name, published_version FROM artifacts WHERE workspace_id = $1 AND type = $2 ORDER BY id',
      [ws, 'brand'],
    );
    expect(rows.rows).toEqual([
      { id: archived.artifactId, archived: true, name: 'Old brand', published_version: null },
      { id: importedId, archived: false, name: 'Current brand', published_version: 1 },
    ]);
  });

  it('targets the surviving singleton, not a migration-archived duplicate', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const survivor = await api.call('artifacts.create', { type: 'brand', name: 'Survivor', content: { siteName: 'Survivor' } });
    const duplicate = await archivedDuplicate(ws);
    const importedId = newId('brd');

    const out = await api.call('config.import', {
      bundle: bundleOf([{ id: importedId, type: 'brand', name: 'Imported', content: { siteName: 'Imported' } }]),
      dryRun: false,
      publish: true,
    });

    expect(out.changes).toMatchObject([{ id: survivor.artifactId, type: 'brand', action: 'update', publish: 'published' }]);
    expect((await publishedBrand(ws))?.siteName).toBe('Imported');
    const rows = await t.srv.db.admin.query<{ id: string; archived: boolean; name: string }>(
      'SELECT id, archived, name FROM artifacts WHERE workspace_id = $1 AND type = $2 ORDER BY id',
      [ws, 'brand'],
    );
    expect(rows.rows.find((r) => r.id === survivor.artifactId)).toMatchObject({ archived: false, name: 'Imported' });
    expect(rows.rows.find((r) => r.id === duplicate)).toMatchObject({ archived: true, name: 'Duplicate brand (archived duplicate)' });
  });

  it('restores an explicit archived singleton id when no active singleton exists', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const brand = await api.call('artifacts.create', { type: 'brand', name: 'Archived brand', content: { siteName: 'Archived' } });
    await archive(ws, brand.artifactId);

    const out = await api.call('config.import', {
      bundle: bundleOf([{ id: brand.artifactId, type: 'brand', name: 'Restored brand', content: { siteName: 'Restored' } }]),
      dryRun: false,
      publish: true,
    });

    expect(out.changes).toMatchObject([{ id: brand.artifactId, type: 'brand', action: 'update', publish: 'published' }]);
    expect((await publishedBrand(ws))?.siteName).toBe('Restored');
    const [row] = (
      await t.srv.db.admin.query<{ archived: boolean; published_version: number | null }>(
        'SELECT archived, published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
        [ws, brand.artifactId],
      )
    ).rows;
    expect(row).toEqual({ archived: false, published_version: 1 });
  });

  it('refuses an explicit archived singleton id when an active singleton exists', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const archived = await api.call('artifacts.create', { type: 'brand', name: 'Archived brand', content: { siteName: 'Archived' } });
    await archive(ws, archived.artifactId);
    const active = await api.call('artifacts.create', { type: 'brand', name: 'Active brand', content: { siteName: 'Active' } });

    const err = await rejects(
      api.call('config.import', {
        bundle: bundleOf([{ id: archived.artifactId, type: 'brand', name: 'Conflicting brand', content: { siteName: 'Conflicting' } }]),
        dryRun: false,
      }),
    );

    expect(err.code).toBe('conflict');
    expect(err.message).toContain(archived.artifactId);
    expect(err.message).toContain(active.artifactId);
    expect(await publishedBrand(ws)).toBeNull();
  });

  it('serialises a concurrent create and import, so one answers conflict and none gets a 500', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const blocker = await t.srv.db.admin.connect();
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE artifacts IN SHARE MODE');
      const importId = newId('brd');
      const imported = api.call('config.import', {
        bundle: bundleOf([{ id: importId, type: 'brand', name: 'Imported brand', content: { siteName: 'Imported' } }]),
        dryRun: false,
        publish: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const created = api.call('artifacts.create', { type: 'brand', name: 'Created brand', content: { siteName: 'Created' } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await blocker.query('COMMIT');
      committed = true;

      const results = await Promise.allSettled([imported, created]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const err = (rejected[0] as PromiseRejectedResult).reason as { code: string; message: string };
      expect(err.code).toBe('conflict');
      expect(err.message).not.toMatch(/internal|500/i);
      const rows = await t.srv.db.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM artifacts WHERE workspace_id = $1 AND type = 'brand'",
        [ws],
      );
      expect(rows.rows[0]?.n).toBe(1);
    } finally {
      if (!committed) await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
  }, 30_000);

  it('maps a forced 23505 on the singleton index to conflict', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    await api.call('artifacts.create', { type: 'brand', name: 'Existing brand', content: { siteName: 'Existing' } });

    await expect(
      t.srv.executor.execute(forceSingletonConflict, {}, userPrincipal(owner.id, ws, 'owner'), { surface: 'internal' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const rows = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM artifacts WHERE workspace_id = $1 AND type = 'brand'",
      [ws],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });
});
