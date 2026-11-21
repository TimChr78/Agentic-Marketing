import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { enrollProfiles, enrollSegment } from '../src/commands';

// #1149: journeys.enroll accepted merged-away ids and archived journeys. A merged-away id bypassed
// re-entry (checked against the alias), got a second holdout row and wrote a participant the sweep
// could no longer read consent or wake for. The handler now follows the merge under the identity
// lock and dedupes, and both enrol commands refuse an archived journey.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journeys_enroll_merge');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function seedProfile(id: string, mergedInto: string | null = null) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, mergedInto });
    if (mergedInto) await tx.insert(schema.profileMerges).values({ workspaceId: ws, fromId: id, intoId: mergedInto, reason: 'test merge' });
  });
}

const definition = (reentry: 'once' | 'always' = 'once') => ({
  purpose: 'marketing_email',
  controlGroup: { percent: 50, minSampleSize: 1 },
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Manual Entry', reentry } },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
});

async function publishJourney(type: 'journey' | 'segment' = 'journey', reentry: 'once' | 'always' = 'once') {
  const id = newId(type === 'journey' ? 'jrn' : 'seg');
  const content = type === 'journey' ? definition(reentry) : { mode: 'static' };
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: ws,
      id,
      type,
      name: `Test ${type}`,
      latestVersion: 1,
      publishedVersion: 1,
    });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: id,
      number: 1,
      state: 'published',
      content,
      contentHash: `hash_${id}`,
      authorType: 'user',
      authorId: 'user_test',
    });
  });
  return id;
}

const context = (tx: unknown) =>
  ({
    tx,
    principal: { workspaceId: ws },
    afterCommit: (fn: () => unknown) => fn(),
    services: { events: { insertJourneyEvents: async () => {} } },
  }) as never;

describe.skipIf(!hasTestDatabase())('journeys.enroll follows merges and refuses archived journeys (#1149)', () => {
  it('enrols the canonical survivor and records one holdout row for a merged-away id', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor);
    await seedProfile(alias, survivor);
    const journeyId = await publishJourney();

    const out = await d.db.withWorkspace(ws, (tx) =>
      enrollProfiles.handler({ artifactId: journeyId, profileIds: [alias], reason: 'test' }, context(tx)),
    );

    expect(out).toMatchObject({ entered: 1, skipped: 0 });
    const participants = await d.db.admin.query<{ profile_id: string }>(
      'SELECT profile_id FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2',
      [ws, journeyId],
    );
    expect(participants.rows).toEqual([{ profile_id: survivor }]);
    const holdout = await d.db.admin.query<{ profile_id: string }>(
      'SELECT profile_id FROM holdout_assignments WHERE workspace_id = $1 AND scope_type = $2 AND scope_id = $3',
      [ws, 'journey', journeyId],
    );
    expect(holdout.rows).toEqual([{ profile_id: survivor }]);
  }, 60_000);

  it('respects reentry: once when the same person is sent through a merged-away id', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor);
    await seedProfile(alias, survivor);
    const journeyId = await publishJourney();

    const first = await d.db.withWorkspace(ws, (tx) =>
      enrollProfiles.handler({ artifactId: journeyId, profileIds: [survivor] }, context(tx)),
    );
    const second = await d.db.withWorkspace(ws, (tx) =>
      enrollProfiles.handler({ artifactId: journeyId, profileIds: [alias] }, context(tx)),
    );

    expect(first.entered).toBe(1);
    expect(second).toMatchObject({ entered: 0, skipped: 1 });
    const count = await d.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2',
      [ws, journeyId],
    );
    expect(count.rows[0]?.n).toBe(1);
  }, 60_000);

  it('dedupes two requested ids that resolve to the same person', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor);
    await seedProfile(alias, survivor);
    const journeyId = await publishJourney('journey', 'always');

    const out = await d.db.withWorkspace(ws, (tx) =>
      enrollProfiles.handler({ artifactId: journeyId, profileIds: [alias, survivor, alias] }, context(tx)),
    );

    expect(out).toMatchObject({ entered: 1, skipped: 2 });
  }, 60_000);

  it('rejects an archived journey in journeys.enroll and journeys.enrollSegment', async () => {
    const journeyId = await publishJourney();
    await d.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, journeyId]);

    await expect(
      d.db.withWorkspace(ws, (tx) => enrollProfiles.handler({ artifactId: journeyId, profileIds: [newId('prf')] }, context(tx))),
    ).rejects.toThrow(/archived/i);

    const segmentId = await publishJourney('segment');
    await expect(
      d.db.withWorkspace(ws, (tx) =>
        enrollSegment.handler({ artifactId: journeyId, segmentId, reason: 'test', idempotencyKey: 'test-key-archived' }, context(tx)),
      ),
    ).rejects.toThrow(/archived/i);
  }, 60_000);
});
