import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { assignHoldout, holdoutHashVersion, holdoutWinners } from '../src/holdout';

// #972: the report chooses each person's winning assignment in PostgreSQL instead of loading the
// scope's whole history. Its order must stay exactly the send path's (`oldestArm`): the earliest
// `assigned_at` to the microsecond, then the lower profile id in code-unit order.

let d: DisposableDb;

beforeAll(async () => {
  if (hasTestDatabase()) d = await createDisposableDb('holdout_winners');
}, 180_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('holdoutWinners (#972)', () => {
  it('chooses the same arm as the send path for a tie and a sub-millisecond difference', async () => {
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
         ($1, 'prf_micro_alias', 'prf_micro_survivor'),
         ($1, 'prf_micro_survivor', NULL),
         ($1, 'prf_tie_alias', 'prf_tie_survivor'),
         ($1, 'prf_tie_survivor', NULL)`,
      [d.workspace],
    );
    const scope = { type: 'campaign' as const, id: 'cmp_00000000000000000000000000000972' };
    const hash = holdoutHashVersion(50);
    // The microsecond pair is inside one millisecond: the survivor's control (…123100) is older
    // than the alias's treatment (…123900), so a millisecond-precision comparison would call it a
    // tie and let the alias's lower id win. The tie pair is on the same instant, where the alias's
    // lower id does decide.
    await d.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at) VALUES
         ($1, 'campaign', $2, $3, 'prf_micro_alias', 'treatment', '2026-11-01T00:00:00.123900Z'),
         ($1, 'campaign', $2, $3, 'prf_micro_survivor', 'control', '2026-11-01T00:00:00.123100Z'),
         ($1, 'campaign', $2, $3, 'prf_tie_alias', 'treatment', '2026-11-01T00:00:01.000000Z'),
         ($1, 'campaign', $2, $3, 'prf_tie_survivor', 'control', '2026-11-01T00:00:01.000000Z')`,
      [d.workspace, scope.id, hash],
    );

    await d.db.withWorkspace(d.workspace, async (tx) => {
      // The send path reads the same rows through oldestArm/assignHoldout.
      const micro = await assignHoldout(tx, d.workspace, scope, { percent: 50 }, 'prf_micro_survivor');
      const tie = await assignHoldout(tx, d.workspace, scope, { percent: 50 }, 'prf_tie_survivor');
      expect(micro?.assignment.arm).toBe('control');
      expect(tie?.assignment.arm).toBe('treatment');

      const winners = await holdoutWinners(tx, d.workspace, scope, hash);
      const page = await winners.page(undefined, 10);
      expect(page.map((winner) => [winner.person, winner.arm])).toEqual([
        ['prf_micro_survivor', 'control'],
        ['prf_tie_survivor', 'treatment'],
      ]);
      expect([winners.control, winners.treatment]).toEqual([1, 1]);
    });
  }, 60_000);

  it('applies the window to the winning assignment, not to an alias row', async () => {
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
         ($1, 'prf_window_alias', 'prf_window_survivor'),
         ($1, 'prf_window_survivor', NULL)`,
      [d.workspace],
    );
    const scope = { type: 'campaign' as const, id: 'cmp_00000000000000000000000000000973' };
    const hash = holdoutHashVersion(50);
    // The earliest assignment is control on the alias, before the window; the survivor's later
    // treatment is inside it. The send uses control, so the report must choose control first and
    // then leave the person out of the window entirely (#944, unchanged by #972).
    await d.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at) VALUES
         ($1, 'campaign', $2, $3, 'prf_window_alias', 'control', '2026-10-01T00:00:00Z'),
         ($1, 'campaign', $2, $3, 'prf_window_survivor', 'treatment', '2026-11-01T00:00:00Z')`,
      [d.workspace, scope.id, hash],
    );

    await d.db.withWorkspace(d.workspace, async (tx) => {
      const all = await holdoutWinners(tx, d.workspace, scope, hash);
      expect([all.control, all.treatment]).toEqual([1, 0]);
      expect((await all.page(undefined, 10)).map((winner) => winner.arm)).toEqual(['control']);

      const windowed = await holdoutWinners(tx, d.workspace, scope, hash, {
        from: new Date('2026-10-15T00:00:00Z'),
        to: new Date('2026-11-15T00:00:00Z'),
      });
      expect([windowed.control, windowed.treatment]).toEqual([0, 0]);
      expect([windowed.first, windowed.last]).toEqual([null, null]);
      expect(await windowed.page(undefined, 10)).toEqual([]);
    });
  }, 60_000);
});
