import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #868: two concurrent approvals of v1 and v2 of one unpublished artifact both read
// `publishedVersion = null`, each mark their own version published, and the second overwrites the
// pointer. Approvals lock every affected artifact before publishing; publishVersion locks before it
// reads the live version.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01417_868', testPort(4451));
  owner = await t.signUp(`owner-v01417-868-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const note = (title: string) => ({ title, body: 'Written for the artifact integrity test.' });

describe('concurrent approvals publish exactly one version (#868)', () => {
  it('keeps one published version and the pointer to it', async () => {
    const approver = await t.signUp(`approver-v01417-868-${Date.now()}@example.com`);
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const api = t.api(owner, ws);
    const approverApi = t.api(approver, ws);
    const created = await api.call('artifacts.create', { type: 'note', name: 'Two requests', content: note('v1') });
    const artifactId = created.artifactId;

    const first = await api.call('artifacts.requestPublish', { artifactId, note: 'Request v1' });
    expect(first.status).toBe('in_review');
    await api.call('artifacts.updateDraft', { artifactId, content: note('v2'), note: 'Second version' });
    const second = await api.call('artifacts.requestPublish', { artifactId, note: 'Request v2' });
    expect(second.status).toBe('in_review');
    expect(second.version).toBe(2);
    const approvalIds = [first.approvalId as string, second.approvalId as string];

    const lock = await t.srv.db.admin.connect();
    let approvals: Promise<{ status: string }>[] = [];
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, artifactId]);
      approvals = approvalIds.map((approvalId) => approverApi.call('approvals.approve', { approvalId }));
      await sleep(400);
    } finally {
      await lock.query('COMMIT');
      lock.release();
    }
    const results = await Promise.all(approvals);
    expect(results.map((r) => r.status)).toEqual(['approved', 'approved']);

    const versions = await t.srv.db.admin.query<{ number: number; state: string }>(
      'SELECT number, state FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2 ORDER BY number',
      [ws, artifactId],
    );
    const published = versions.rows.filter((v) => v.state === 'published');
    expect(published).toHaveLength(1);
    const artifact = await t.srv.db.admin.query<{ published_version: number }>(
      'SELECT published_version FROM artifacts WHERE workspace_id = $1 AND id = $2',
      [ws, artifactId],
    );
    expect(artifact.rows[0]?.published_version).toBe(published[0]?.number);
  });
});
