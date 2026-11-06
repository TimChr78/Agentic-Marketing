import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Wave 5, Phase 24 (B7, #445): approvals.list gains the completeness metadata a destination needs
// — a total for the same status/artifact filter and a keyset cursor — while keeping bundle member
// resolution exactly as it was.

const PORT = testPort(3513);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const api = () => t.api(owner);
const list = (input: any) => api().call('approvals.list', input);

const note = async (name: string) =>
  (await api().call('artifacts.create', { type: 'note', name, content: { title: name, body: `${name} body` } })).artifactId;

const pending = async (artifactId: string) =>
  (await api().call('artifacts.requestPublish', { artifactId, note: 'approvals.list test' })).approvalId!;

const setStatus = (ids: string[], status: string) =>
  t.srv.db.admin.query(
    `UPDATE approval_requests SET status = $3, decided_at = now(), decided_by = $4 WHERE workspace_id = $1 AND id = ANY($2)`,
    [ws, ids, status, owner.id],
  );

let pendingIds: string[] = [];
let bundleId = '';
let bundleApprovalIds: string[] = [];
let bundleArtifacts: string[] = [];

beforeAll(async () => {
  t = await startTestServer('test_approvals_list', PORT);
  owner = await t.signUp(`owner-approvals-list-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');

  const standalone: string[] = [];
  for (let i = 0; i < 10; i++) {
    const artifactId = await note(`Request ${i}`);
    const approvalId = await pending(artifactId);
    standalone.push(approvalId);
  }
  // Three approved, one rejected, one withdrawn; five stay pending.
  await setStatus(standalone.slice(0, 3), 'approved');
  await setStatus([standalone[3]!], 'rejected');
  await setStatus([standalone[4]!], 'withdrawn');
  pendingIds = standalone.slice(5);

  // A bundle's rows stay grouped the way approvals.get reports them.
  bundleArtifacts = [await note('Bundle A'), await note('Bundle B')];
  const bundle = await api().call('artifacts.requestPublishBundle', { artifactIds: bundleArtifacts, note: 'bundle' });
  bundleId = bundle.bundleId!;
  bundleApprovalIds = bundle.members.map((m) => m.approvalId!).filter(Boolean);

  // One shared microsecond: the id tie-break has to carry the page boundary.
  await t.srv.db.admin.query(`UPDATE approval_requests SET created_at = '2026-11-04 12:34:56.123456+00' WHERE workspace_id = $1`, [ws]);
}, 180_000);

afterAll(() => t?.close());

describe('approvals.list completeness metadata (B7)', () => {
  it('reports the total for each status filter, independent of the page', async () => {
    const counts = { pending: 7, approved: 3, rejected: 1, withdrawn: 1 } as const;
    for (const [status, total] of Object.entries(counts)) {
      const page = await list({ status, limit: 2 });
      expect(page.total, status).toBe(total);
      expect(page.approvals.length).toBeLessThanOrEqual(2);
    }
    expect((await list({ status: 'pending', limit: 200 })).approvals).toHaveLength(7);
  });

  it('pages all pending rows once with a stable total and no gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list({ status: 'pending', limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(7);
      seen.push(...page.approvals.map((a) => a.id));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set([...pendingIds, ...bundleApprovalIds]));
  });

  it('keeps bundle member resolution and the artifact filter', async () => {
    const page = await list({ status: 'pending', limit: 200 });
    const bundleRows = page.approvals.filter((a) => a.bundle?.id === bundleId);
    expect(bundleRows).toHaveLength(2);
    for (const row of bundleRows) {
      const detail = await api().call('approvals.get', { approvalId: row.id });
      expect(row.bundle).toEqual(detail.bundle);
      expect(row.bundle!.members.map((m) => m.artifactId).sort()).toEqual([...bundleArtifacts].sort());
    }

    const filtered = await list({ status: 'pending', artifactId: bundleArtifacts[0], limit: 200 });
    expect(filtered.total).toBe(1);
    expect(filtered.approvals.map((a) => a.bundle?.id)).toEqual([bundleId]);
  });

  it('rejects a malformed cursor instead of restarting', async () => {
    await expect(list({ status: 'pending', cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
