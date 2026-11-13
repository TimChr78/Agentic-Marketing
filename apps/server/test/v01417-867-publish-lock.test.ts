import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #867: a person's publish must lock the artifact before reading the draft and its author. An
// agent's updateDraft committed between that read and publishVersion otherwise goes live
// unreviewed under `agent_changes`.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01417_867', testPort(4450));
  owner = await t.signUp(`owner-v01417-867-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const note = (title: string, body = 'Written for the artifact integrity test.') => ({ title, body });

describe('a person’s publish waits for an agent’s concurrent draft rewrite (#867)', () => {
  it('reviews the agent content instead of publishing it', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'agent_changes');
    const api = t.api(owner, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Review me', content: note('Person draft') });
    const artifactId = created.artifactId;

    const writer = await t.srv.db.admin.connect();
    let request: Promise<{ status: string; approvalId: string | null }> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, artifactId]);
      const agentContent = note('Agent rewrite');
      await writer.query(
        `UPDATE artifact_versions
            SET content = $3::jsonb, author_type = 'agent', author_id = 'agt_test'
          WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
        [ws, artifactId, JSON.stringify(agentContent)],
      );
      // The person's publish starts while the agent's write is still uncommitted.
      request = api.call('artifacts.requestPublish', { artifactId, note: 'Publish my draft' });
      await sleep(400);
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    const out = await request!;

    // The agent's author must be seen: an agent change under `agent_changes` needs review.
    expect(out.status).toBe('in_review');
    expect(out.approvalId).toBeTruthy();
    const row = await t.srv.db.admin.query<{ published_version: number | null }>(
      'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, artifactId],
    );
    expect(row.rows[0]?.published_version).toBeNull();
    const version = await t.srv.db.admin.query<{ state: string; content: { title: string }; author_type: string }>(
      'SELECT state, content, author_type FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1',
      [ws, artifactId],
    );
    expect(version.rows[0]).toMatchObject({ state: 'in_review', author_type: 'agent', content: { title: 'Agent rewrite' } });
  });

  it('does the same for a bundle', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'agent_changes');
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', { type: 'note', name: 'Bundle one', content: note('One') });
    const second = await api.call('artifacts.create', { type: 'note', name: 'Bundle two', content: note('Two') });
    const artifactIds = [first.artifactId, second.artifactId];

    const writer = await t.srv.db.admin.connect();
    let request: Promise<{ status: string; members: { approvalId: string | null }[] }> | undefined;
    try {
      await writer.query('BEGIN');
      // A person's bundle must lock every member before reading any of them.
      await writer.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = ANY($2::text[]) FOR UPDATE', [ws, artifactIds]);
      const agentContent = note('Agent bundle rewrite');
      await writer.query(
        `UPDATE artifact_versions
            SET content = $3::jsonb, author_type = 'agent', author_id = 'agt_test'
          WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
        [ws, second.artifactId, JSON.stringify(agentContent)],
      );
      request = api.call('artifacts.requestPublishBundle', { artifactIds, note: 'Publish the pair' });
      await sleep(400);
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    const out = await request!;

    expect(out.status).toBe('in_review');
    expect(out.members.every((m) => m.approvalId)).toBe(true);
    const rows = await t.srv.db.admin.query<{ id: string; published_version: number | null }>(
      'SELECT id, published_version FROM artifacts WHERE workspace_id = $1 AND id = ANY($2::text[])',
      [ws, artifactIds],
    );
    expect(rows.rows.every((r) => r.published_version === null)).toBe(true);
  });
});
