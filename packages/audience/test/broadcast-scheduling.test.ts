import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { broadcastDeferMs, dueBroadcastRuns } from '../src/broadcasts';

// #978 part 2 review: a publication deferral must not let the same stalled runs occupy the due
// queue every tick. The selection is ordered by next-eligibility (lease_until), oldest first, so a
// run that just deferred goes to the back; the wait itself doubles from 2 s to a 60 s cap.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('broadcast_schedule');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const run = (id: string, lease: string, sendAt: string) =>
  d.db.withWorkspace(d.workspace, (tx) =>
    tx.insert(schema.broadcastRuns).values({
      workspaceId: d.workspace,
      broadcastId: id,
      version: 1,
      status: 'running',
      sendAt: new Date(sendAt),
      leaseUntil: new Date(lease),
    }),
  );

describe.skipIf(!hasTestDatabase())('broadcast due-run fairness (#978 part 2)', () => {
  it('backs off publication deferrals from 2 s to a 60 s cap', () => {
    expect([1, 2, 3, 5, 6, 10].map(broadcastDeferMs)).toEqual([2_000, 4_000, 8_000, 32_000, 60_000, 60_000]);
  });

  it('puts a deferred run behind an unrelated due broadcast', async () => {
    const other = newId('bct');
    const stalled = Array.from({ length: 20 }, () => newId('bct'));
    // All 21 are due. The stalled runs just came out of a 2 s deferral; the unrelated broadcast
    // has been waiting longer. Inserted last: an unordered LIMIT 20 would take the stalled runs and
    // never the other one.
    for (const id of stalled) await run(id, new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString());
    await run(other, new Date(Date.now() - 300_000).toISOString(), new Date(Date.now() - 7_200_000).toISOString());

    const first = await dueBroadcastRuns(d.db, 20);
    expect(first).toHaveLength(20);
    expect(first[0]?.broadcastId).toBe(other);
    expect(first.some((r) => r.broadcastId === other)).toBe(true);

    // The next tick: the other run was processed and deferred (future lease), so the stalled runs
    // get their turn.
    await d.db.admin.query(
      `UPDATE broadcast_runs SET lease_until = CASE WHEN broadcast_id = $2 THEN now() + interval '2 seconds' ELSE now() - interval '1 second' END
        WHERE workspace_id = $1`,
      [d.workspace, other],
    );
    const second = await dueBroadcastRuns(d.db, 20);
    expect(second).toHaveLength(20);
    expect(second.some((r) => r.broadcastId === other)).toBe(false);
    expect(second.map((r) => r.broadcastId)).toEqual(stalled.slice(0, 20).sort());
  });
});
