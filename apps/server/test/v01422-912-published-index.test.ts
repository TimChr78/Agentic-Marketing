import { defineCommand, userPrincipal } from '@agentic-marketing/commands';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestServer, testPort, type User } from './harness';

// #912: `artifact_versions` has a partial unique index on (workspace_id, artifact_id) where
// state = 'published'. The normal publish path supersedes the old version before it publishes the
// new one, and a writer that skips that order gets a 23505 the executor answers as a conflict.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01422_912', testPort(4462));
  owner = await t.signUp(`owner-v01422-912-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const note = (title: string) => ({ title, body: 'Written for the artifact integrity test.' });

/** A command that publishes a second version without superseding the first, forcing the index. */
const forceSecondPublished = defineCommand({
  name: 'test.forceSecondPublished',
  title: 'Force a second published version',
  description: 'Test-only command: mark another version published and hit the one-published index.',
  input: z.object({ artifactId: z.string(), number: z.number().int() }),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    await ctx.tx
      .update(schema.artifactVersions)
      .set({ state: 'published', updatedAt: new Date() })
      .where(
        and(
          eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
          eq(schema.artifactVersions.artifactId, input.artifactId),
          eq(schema.artifactVersions.number, input.number),
        ),
      );
    return { ok: true };
  },
});

const states = async (ws: string, artifactId: string) => {
  const { rows } = await t.srv.db.admin.query<{ number: number; state: string }>(
    'SELECT number, state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number',
    [ws, artifactId],
  );
  return Object.fromEntries(rows.map((r) => [r.number, r.state]));
};

describe('one published version per artifact (#912)', () => {
  it('publishes a second version with the old one superseded first', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Two versions', content: note('v1') });
    expect((await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' })).status).toBe('published');
    await api.call('artifacts.updateDraft', { artifactId: created.artifactId, content: note('v2'), note: 'v2' });
    expect((await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v2' })).status).toBe('published');

    expect(await states(ws, created.artifactId)).toEqual({ 1: 'superseded', 2: 'published' });
    const row = await t.srv.db.admin.query<{ published_version: number }>(
      'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, created.artifactId],
    );
    expect(row.rows[0]?.published_version).toBe(2);
  });

  it('refuses a direct second published row with 23505', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Direct write', content: note('v1') });
    await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' });
    await api.call('artifacts.updateDraft', { artifactId: created.artifactId, content: note('v2'), note: 'v2' });

    await expect(
      t.srv.db.admin.query(`UPDATE artifact_versions SET state = 'published' WHERE workspace_id = $1 AND artifact_id = $2 AND number = 2`, [
        ws,
        created.artifactId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      t.srv.db.admin.query(
        `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
         VALUES ($1, $2, 3, 'published', '{}'::jsonb, 'hash-3', 'user', $3)`,
        [ws, created.artifactId, owner.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await states(ws, created.artifactId)).toEqual({ 1: 'published', 2: 'draft' });
  });

  it('maps the index violation to a conflict in the executor', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Executor mapping', content: note('v1') });
    await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v1' });
    await api.call('artifacts.updateDraft', { artifactId: created.artifactId, content: note('v2'), note: 'v2' });

    const err = await t.srv.executor
      .execute(forceSecondPublished, { artifactId: created.artifactId, number: 2 }, userPrincipal(owner.id, ws, 'owner'), {
        surface: 'internal',
      })
      .catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/already has a published version/i);
    expect(await states(ws, created.artifactId)).toEqual({ 1: 'published', 2: 'draft' });
  });
});
