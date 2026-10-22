import { contextFor, evaluate } from '@agentic-marketing/segments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLoadTest, SEGMENTS } from '../src/loadtest';
import { startTestServer } from './harness';

// Phase 10 (wave 2), part b: segments are evaluated in SQL over the whole workspace, checked
// against the in-memory evaluator, and the load test runs end to end on a small population.

let t: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  t = await startTestServer('test_p10_scale', 3288);
}, 60_000);
afterAll(() => t?.close());

describe('segment evaluation at scale', () => {
  it('runs the load test: every segment has the size the synthetic data implies, and a re-run moves nobody', async () => {
    const report = await runLoadTest({ db: t.srv.db, events: t.srv.events }, { profiles: 4000 });
    expect(report.segments.map((s) => [s.members, s.expected])).toEqual(report.segments.map((s) => [s.expected, s.expected]));
    expect(report.segments.find((s) => s.name.startsWith('combined'))?.members).toBe(800);
    const { rows } = await t.srv.db.admin.query('SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1', [report.workspaceId]);
    expect(rows[0].n).toBe(0); // cleaned up
  });

  it('gives the same members in SQL as the in-memory evaluator', async () => {
    // The load test's refreshes (SQL) leave their members behind with --keep.
    const { workspaceId: ws } = await runLoadTest({ db: t.srv.db, events: t.srv.events }, { profiles: 600, keep: true });
    for (const [i, s] of SEGMENTS.entries()) {
      const inMemory = await t.srv.db.withWorkspace(ws, (tx) => evaluate(s.condition, contextFor(tx, ws, t.srv.events, [])));
      const { rows } = await t.srv.db.admin.query<{ profile_id: string }>(
        'SELECT profile_id FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2',
        [ws, `seg_${(i + 1).toString(16).padStart(32, '0')}`],
      );
      expect(new Set(rows.map((r) => r.profile_id))).toEqual(inMemory);
      expect(inMemory.size).toBe(s.expected(600));
    }
  });
});
