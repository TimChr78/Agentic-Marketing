import type { AudienceSync } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { type AudienceSyncDeps, type DestinationRef, processMergeRepair } from '../src/audiences';

// #1093: the audience merge repair resolves the survivor through the shared merge walk (256 hops,
// cycle-safe). The old 20-hop walk stopped on a node that was still merged, so a member 21+ merges
// deep was moved onto an alias instead of being folded into the real survivor's row.

const HOPS = 25;
const chain = Array.from({ length: HOPS }, () => newId('prf'));
const survivor = chain[chain.length - 1]!;
const syncId = newId('aud');

let d: Awaited<ReturnType<typeof createDisposableDb>>;

const ref: DestinationRef = {
  platform: 'meta',
  connectionId: 'con_deep_merge',
  destinationId: 'act_123',
  operatingAccountId: '',
  loginAccountId: null,
};
const destinationKey = 'con_deep_merge:meta:act_123';
const hashes = { email: 'hash-a' };

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ads_deep_merge_repair');
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values(
      chain.map((id, i) => ({
        workspaceId: d.workspace,
        id,
        mergedInto: i < chain.length - 1 ? chain[i + 1]! : null,
      })),
    );
    // Both the merged-away member and the survivor have a ledger row with the same hashes.
    await tx.insert(schema.audienceMembers).values(
      [chain[0]!, survivor].map((profileId) => ({
        workspaceId: d.workspace,
        syncId,
        platform: 'meta' as const,
        destinationKey,
        connectionId: ref.connectionId,
        destinationId: ref.destinationId,
        operatingAccountId: '',
        destinationKnown: true,
        profileId,
        hashes,
      })),
    );
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('audience merge repair on a deep merge chain (#1093)', () => {
  it(`folds a member ${HOPS} merges deep into the survivor's row`, async () => {
    await processMergeRepair(
      d.db,
      d.workspace,
      syncId,
      'meta',
      ref,
      {} as AudienceSyncDeps,
      { segment: 'seg_deep' } as AudienceSync,
      [],
      1_000,
    );

    const rows = await d.db.admin.query<{ profile_id: string }>(
      'SELECT profile_id FROM audience_members WHERE workspace_id = $1 AND sync_id = $2 ORDER BY profile_id',
      [d.workspace, syncId],
    );
    // The duplicate is deleted and the survivor keeps the ledger row, exactly as for a short chain.
    expect(rows.rows).toEqual([{ profile_id: survivor }]);
  }, 60_000);
});
