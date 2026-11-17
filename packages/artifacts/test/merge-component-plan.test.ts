import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { holdoutHashVersion, oldestArmQuery } from '../src/holdout';

// #1015 review, finding A: the cycle minimum's `COLLATE "C"` used to reach the representative and
// from there the component join, so `profiles_merged_into` (a default-collation partial index) was
// unusable and every send lookup scanned the workspace's profiles. The plan guard below fails if
// that comes back: with a hundred thousand unrelated merges, a send lookup must not scan `profiles`.

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function profileNodes(node: PlanNode): PlanNode[] {
  const own = node['Relation Name'] === 'profiles' ? [node] : [];
  return [...own, ...(node.Plans ?? []).flatMap(profileNodes)];
}

let d: DisposableDb;

beforeAll(async () => {
  if (hasTestDatabase()) d = await createDisposableDb('merge_component_plan');
}, 180_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('the send arm lookup plan (#1015)', () => {
  it('reaches the merge component through profiles_merged_into, not a scan of profiles', async () => {
    const merges = 100_000;
    // A workspace full of unrelated merges: if the index cannot be used, this is what the planner
    // has to scan for every send.
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, merged_into)
       SELECT $1, 'prf_plan_a_' || g, 'prf_plan_b_' || g FROM generate_series(1, $2) AS g`,
      [d.workspace, merges],
    );
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id)
       SELECT $1, 'prf_plan_b_' || g FROM generate_series(1, $2) AS g`,
      [d.workspace, merges],
    );
    // The person the send looks up: one alias merged into a survivor.
    await d.db.admin.query(`INSERT INTO profiles (workspace_id, id, merged_into) VALUES ($1, 'prf_plan_alias', 'prf_plan_survivor')`, [
      d.workspace,
    ]);
    await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) VALUES ($1, 'prf_plan_survivor')`, [d.workspace]);
    await d.db.admin.query('ANALYZE profiles');

    const scope = { type: 'campaign' as const, id: 'cmp_plan_0000000000000000000000000000001015' };
    const plan = await d.db.withWorkspace(d.workspace, async (tx) => {
      const res = await tx.execute(
        sql`EXPLAIN (FORMAT JSON) ${oldestArmQuery(d.workspace, scope, holdoutHashVersion(50), 'prf_plan_alias')}`,
      );
      const row = res.rows[0]!;
      return (Object.values(row)[0] as [{ Plan: PlanNode }])[0]!.Plan;
    });

    const profiles = profileNodes(plan);
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.filter((node) => node['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(profiles.some((node) => (node['Index Name'] ?? '').includes('profiles_merged_into'))).toBe(true);
  }, 300_000);
});
