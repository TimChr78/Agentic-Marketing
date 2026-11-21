import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { profileSegments } from '../src/commands';

// #1145: segments.ofProfile queried segment_memberships by the raw profile id. merge() moves
// static and snapshot memberships to the survivor, so a merged-away id returned nothing even
// though the person is still in the segment.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('segments_of_profile_merge');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('segments.ofProfile follows a merge (#1145)', () => {
  it('returns the survivor’s memberships for a merged-away profile id', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    const segmentId = newId('seg');
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values([
        { workspaceId: ws, id: survivor },
        { workspaceId: ws, id: alias, mergedInto: survivor },
      ]);
      await tx.insert(schema.profileMerges).values({ workspaceId: ws, fromId: alias, intoId: survivor, reason: 'test merge' });
      await tx.insert(schema.artifacts).values({
        workspaceId: ws,
        id: segmentId,
        type: 'segment',
        name: 'Newsletter readers',
        latestVersion: 1,
        publishedVersion: 1,
      });
      await tx.insert(schema.segmentMemberships).values({ workspaceId: ws, segmentId, profileId: survivor });
    });

    const out = await d.db.withWorkspace(ws, (tx) =>
      profileSegments.handler({ profileId: alias }, {
        tx,
        principal: { workspaceId: ws, permissions: new Set(['artifacts:read']) },
      } as never),
    );

    expect(out.segments).toMatchObject([{ id: segmentId, name: 'Newsletter readers' }]);
  }, 60_000);
});
