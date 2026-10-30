import { hashValue } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Issue #117: moving a step is layout, not journey content. A layout-only save keeps the version
// (and the artifact's draft state) untouched; a draft can be thrown away back to the live version.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;
let ws: string;

const journey = (label = 'Exit', position = { x: 0, y: 200 }) => ({
  purpose: 'marketing_email',
  nodes: [
    {
      id: 'trigger',
      kind: 'trigger',
      label: 'Signed up',
      config: { event: 'Signed Up', reentry: 'once' },
      next: [{ to: 'exit' }],
      position: { x: 0, y: 0 },
    },
    { id: 'exit', kind: 'exit', label, config: {}, position },
  ],
});

/** A journey with one published version, as the pilot's welcome journey was. */
async function liveJourney(workspace = ws) {
  const api = t.api(owner, workspace);
  const { artifactId } = await api.call('artifacts.create', { type: 'journey', name: 'Welcome', content: journey() });
  await api.call('artifacts.requestPublish', { artifactId, note: 'Go live' });
  return artifactId;
}

beforeAll(async () => {
  t = await startTestServer('test_layout_discard', testPort(3319));
  owner = await t.signUp(`layout-${Date.now()}@example.com`);
  approver = await t.signUp(`layout-approver-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
}, 60_000);
afterAll(() => t?.close());

describe('layout is not content (#117)', () => {
  it('saves a position-only update without creating a version', async () => {
    const api = t.api(owner, ws);
    const artifactId = await liveJourney();
    const before = await api.call('artifacts.get', { artifactId });
    expect(before.layout).toBeNull();

    const moved = structuredClone(before.version.content) as ReturnType<typeof journey>;
    moved.nodes[1]!.position = { x: 12, y: 34 };
    const saved = await api.call('artifacts.updateDraft', {
      artifactId,
      content: moved,
      expectedContentHash: before.version.contentHash,
    });
    expect(saved).toMatchObject({ version: 1, state: 'published', layoutOnly: true, contentHash: before.version.contentHash });

    const after = await api.call('artifacts.get', { artifactId });
    expect(after.latestVersion).toBe(1);
    expect(after.version.number).toBe(1);
    expect(after.layout?.positions).toEqual({ trigger: { x: 0, y: 0 }, exit: { x: 12, y: 34 } });
    // The version itself still has the positions it was published with.
    expect((after.version.content as ReturnType<typeof journey>).nodes[1]!.position).toEqual({ x: 0, y: 200 });
    expect((await api.call('artifacts.history', { artifactId })).versions.map((v) => v.number)).toEqual([1]);
  });

  it('still creates a version when content and positions change, and moves the layout with it', async () => {
    const api = t.api(owner, ws);
    const artifactId = await liveJourney();
    const before = await api.call('artifacts.get', { artifactId });
    const changed = structuredClone(before.version.content) as ReturnType<typeof journey>;
    changed.nodes[1]!.label = 'Done';
    changed.nodes[1]!.position = { x: 5, y: 6 };
    const saved = await api.call('artifacts.updateDraft', { artifactId, content: changed });
    expect(saved).toMatchObject({ version: 2, state: 'draft', layoutOnly: false });

    const after = await api.call('artifacts.get', { artifactId });
    expect(after.latestVersion).toBe(2);
    expect(after.layout?.positions).toEqual({ trigger: { x: 0, y: 0 }, exit: { x: 5, y: 6 } });
    expect((await api.call('artifacts.diff', { artifactId })).layoutOnly).toBe(false);
  });

  it('marks a diff between versions that only moved steps as layoutOnly', async () => {
    const api = t.api(owner, ws);
    const artifactId = await liveJourney();
    const published = await api.call('artifacts.get', { artifactId });
    const moved = structuredClone(published.version.content) as ReturnType<typeof journey>;
    moved.nodes[0]!.position = { x: -2, y: -12 };
    // An older client made such a version before layout became separate.
    await t.srv.db.admin.query(
      `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, based_on, author_type, author_id)
       VALUES ($1, $2, 2, 'draft', $3, $4, 1, 'user', $5)`,
      [ws, artifactId, moved, hashValue(moved), owner.id],
    );
    await t.srv.db.admin.query('UPDATE artifacts SET latest_version = 2 WHERE workspace_id = $1 AND id = $2', [ws, artifactId]);
    const d = await api.call('artifacts.diff', { artifactId });
    expect(d.layoutOnly).toBe(true);
    expect(d.changes.every((c) => c.path.startsWith('nodes[') && c.path.includes('].position'))).toBe(true);
  });
});

describe('discard draft', () => {
  it('deletes unpublished versions and returns to the live one', async () => {
    const api = t.api(owner, ws);
    const artifactId = await liveJourney();
    const live = await api.call('artifacts.get', { artifactId });
    const changed = structuredClone(live.version.content) as ReturnType<typeof journey>;
    changed.nodes[1]!.label = 'Finished';
    await api.call('artifacts.updateDraft', { artifactId, content: changed });

    const discarded = await api.call('artifacts.discardDraft', { artifactId });
    expect(discarded).toEqual({ artifactId, version: 1, state: 'published', discardedVersions: [2] });
    const after = await api.call('artifacts.get', { artifactId });
    expect(after).toMatchObject({ latestVersion: 1, publishedVersion: 1 });
    expect(after.version.number).toBe(1);
    expect((await api.call('artifacts.history', { artifactId })).versions).toHaveLength(1);

    const empty = await rejects(api.call('artifacts.discardDraft', { artifactId }));
    expect(empty.status).toBe(409);
    expect(empty.message).toContain('no draft');
  });

  it('refuses when there is no live version to go back to', async () => {
    const api = t.api(owner, ws);
    const { artifactId } = await api.call('artifacts.create', { type: 'journey', name: 'Never live', content: journey() });
    const err = await rejects(api.call('artifacts.discardDraft', { artifactId }));
    expect(err.status).toBe(409);
    expect(err.message).toContain('no live version');
  });

  it('refuses while the draft is waiting for approval, then works after a rejection', async () => {
    const reviewWs = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'none',
    );
    const api = t.api(owner, reviewWs);
    const artifactId = await liveJourney(reviewWs);
    await t.srv.db.admin.query(`UPDATE workspaces SET approval_policy = 'all_publishes' WHERE id = $1`, [reviewWs]);
    const live = await api.call('artifacts.get', { artifactId });
    const changed = structuredClone(live.version.content) as ReturnType<typeof journey>;
    changed.nodes[1]!.label = 'Needs review';
    await api.call('artifacts.updateDraft', { artifactId, content: changed });
    const request = await api.call('artifacts.requestPublish', { artifactId, note: 'Please review' });
    expect(request).toMatchObject({ status: 'in_review', version: 2 });
    expect(request.approvalId).toBeTruthy();

    const blocked = await rejects(api.call('artifacts.discardDraft', { artifactId }));
    expect(blocked.status).toBe(409);
    expect(blocked.message).toContain('waiting for approval');

    await t.api(approver, reviewWs).call('approvals.reject', { approvalId: request.approvalId!, note: 'Not now' });
    const discarded = await api.call('artifacts.discardDraft', { artifactId });
    expect(discarded).toMatchObject({ version: 1, discardedVersions: [2] });
  });
});
