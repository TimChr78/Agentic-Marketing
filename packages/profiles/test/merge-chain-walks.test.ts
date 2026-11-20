import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { recordTopicPreference } from '../src/consent';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';

// #1093: topic writes and erasure resolve the person through the shared merge walk (256 hops,
// cycle-safe), so a link or a request 21+ merges deep still lands on the survivor. The old walk
// stopped at 20, throwing the depth error for a preference write and `not_found` for an erasure.

const MASTER_KEY = Buffer.alloc(32, 37).toString('base64');
const HOPS = 25;

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('profiles_deep_merge_writes');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

/** A chain of `length` profiles, each merged into the next, ending in an unmerged survivor. */
async function seedChain(length: number): Promise<string[]> {
  const chain = Array.from({ length }, () => newId('prf'));
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values(
      chain.map((id, i) => ({
        workspaceId: d.workspace,
        id,
        mergedInto: i < chain.length - 1 ? chain[i + 1]! : null,
      })),
    );
    // A real merge writes both the pointer and the merge row; the erasure family follows the row.
    await tx.insert(schema.profileMerges).values(
      chain.slice(0, -1).map((fromId, i) => ({
        workspaceId: d.workspace,
        fromId,
        intoId: chain[i + 1]!,
        reason: 'test merge',
      })),
    );
  });
  return chain;
}

describe.skipIf(!hasTestDatabase())('deep merge chains in topic writes and erasure (#1093)', () => {
  it(`records a topic choice on the survivor ${HOPS} merges deep instead of failing`, async () => {
    const chain = await seedChain(HOPS);
    const survivor = chain[chain.length - 1]!;

    await d.db.withWorkspace(d.workspace, (tx) =>
      recordTopicPreference(tx, d.workspace, chain[0]!, 'marketing_email', 'news', 'subscribed', 'preference_center'),
    );

    const rows = await d.db.admin.query<{ profile_id: string; status: string }>(
      'SELECT profile_id, status FROM topic_preferences WHERE workspace_id = $1 AND topic = $2',
      [d.workspace, 'news'],
    );
    expect(rows.rows).toEqual([{ profile_id: survivor, status: 'subscribed' }]);
  }, 60_000);

  it('still refuses a chain past the shared bound rather than writing to an alias', async () => {
    const chain = await seedChain(300);
    await expect(
      d.db.withWorkspace(d.workspace, (tx) =>
        recordTopicPreference(tx, d.workspace, chain[0]!, 'marketing_email', 'beyond', 'subscribed', 'preference_center'),
      ),
    ).rejects.toThrow('Profile merge chain exceeds the supported depth.');
  }, 60_000);

  it(`erases the person at the end of a ${HOPS}-hop chain`, async () => {
    const chain = await seedChain(HOPS);
    const prepared = await prepareErasure(d.db, d.workspace, localKeyProvider(MASTER_KEY));
    try {
      const result = await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: chain[0]!,
          requestedBy: 'user_test',
          reason: 'deep merge chain',
          prepared,
        }),
      );
      expect(result.counts.profiles).toBe(HOPS);
      expect(result.profileIds.sort()).toEqual([...chain].sort());
      const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = ANY($2)', [d.workspace, chain]);
      expect(left.rowCount).toBe(0);
    } finally {
      disposeErasure(prepared);
    }
  }, 60_000);
});
