import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { simulateJourney } from '../src/commands';

// journeys.simulate read consent and the person's data under the id the caller supplied. For an id
// a merge had folded away that is the alias's (empty) state, so the dry run told the author a
// message would not be sent when the person had consented. The walk now resolves the id once and
// reads the person it names today, like the runtime does for a live participant.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journeys_simulate_merge');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const definition = {
  purpose: 'marketing_email',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Manual Entry' } },
    { id: 'hook', kind: 'webhook', label: 'Notify the CRM', config: { endpoint: `whk_${'a'.repeat(32)}` } },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
};

async function seedMergedPair() {
  const survivor = newId('prf');
  const alias = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values([
      { workspaceId: ws, id: survivor },
      { workspaceId: ws, id: alias, mergedInto: survivor },
    ]);
    await tx.insert(schema.profileMerges).values({ workspaceId: ws, fromId: alias, intoId: survivor, reason: 'test merge' });
    await tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId: survivor,
      purpose: 'marketing_email',
      channel: '',
      status: 'granted',
      basis: 'consent',
      source: 'api',
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    });
  });
  return { survivor, alias };
}

async function publishJourney() {
  const id = newId('jrn');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx
      .insert(schema.artifacts)
      .values({ workspaceId: ws, id, type: 'journey', name: 'Webhook walk', latestVersion: 1, publishedVersion: 1 });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: id,
      number: 1,
      state: 'published',
      content: definition,
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
    principal: { workspaceId: ws, userId: 'usr_owner', type: 'user', permissions: new Set(['artifacts:read', 'profiles:read']) },
  }) as never;

describe.skipIf(!hasTestDatabase())('journeys.simulate follows a merge', () => {
  it('reads the surviving person’s consent for a merged-away id', async () => {
    const { alias } = await seedMergedPair();
    const journeyId = await publishJourney();

    const out = await d.db.withWorkspace(ws, (tx) =>
      simulateJourney.handler(
        { artifactId: journeyId, profileId: alias, events: [], branches: {}, actions: {}, ai: {}, scores: {}, maxDays: 90 },
        context(tx),
      ),
    );

    const hook = out.steps.find((s) => s.node === 'hook');
    expect(hook?.detail).toBe(`would send a webhook to whk_${'a'.repeat(32)}`);
  }, 60_000);
});
