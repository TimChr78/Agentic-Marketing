import { artifactTypes, DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  // Only the provider key is opened on this path.
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

// The step's gate call is the moment a merge can land. The mock lets the test commit one right
// after the first gate read, on another connection, which is the window #1300 closes.
const hooks = vi.hoisted(() => ({ afterGate: undefined as undefined | (() => Promise<void>) }));

// The context build reads the profile's traits, then the tracking plan, then the identifiers. A
// merge committed between the first and the last read (the window #1300 closes) leaves the
// survivor's id unchanged, so only a revision of that row can tell the build it must start again.
const planHook = vi.hoisted(() => ({ afterTraits: undefined as undefined | (() => Promise<void>) }));
vi.mock('@agentic-marketing/artifacts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/artifacts')>();
  return {
    ...original,
    publishedSingleton: async (...args: Parameters<typeof original.publishedSingleton>) => {
      const answer = await original.publishedSingleton(...args);
      if (args[1] === 'tracking_plan') {
        const after = planHook.afterTraits;
        planHook.afterTraits = undefined;
        if (after) await after();
      }
      return answer;
    },
  };
});

vi.mock('../src/context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/context')>();
  return {
    ...original,
    aiAllowed: async (tx: Parameters<typeof original.aiAllowed>[0], workspaceId: string, profileId: string) => {
      const answer = await original.aiAllowed(tx, workspaceId, profileId);
      const after = hooks.afterGate;
      hooks.afterGate = undefined;
      if (after) await after();
      return answer;
    },
  };
});

import { localKeyProvider } from '@agentic-marketing/secrets';
import { prepareCall } from '../src/steps';
import { fakeLlm } from '../src/testing';

// #1300: a merge can commit after the AI step's consent check and before its context or segment
// cache is read. The step then saw the merged-away profile's cleared traits (decide) or the
// empty-segment cache entry (generate). Preparation now reads the gate again after it built the
// person-dependent input, throws that input away when the person moved, and builds it for the
// survivor.

type Stack = Awaited<ReturnType<typeof createDisposableDb>>;
type CallRow = typeof schema.aiCalls.$inferSelect;

let d: Stack;
let kp: ReturnType<typeof localKeyProvider>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let ws: string;
const providerId = `aip_${'6'.repeat(32)}`;
const decidePrompt = newId('prm');
const generatePrompt = newId('prm');
const segmentId = newId('seg');

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_steps_merge_prepare');
  kp = localKeyProvider(Buffer.alloc(32, 66).toString('base64'));
  ws = d.workspace;
  llm = await fakeLlm(() => ({
    text: JSON.stringify({ option: 'a', rationale: 'Enough signal.' }),
    inputTokens: 20,
    outputTokens: 4,
  }));
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.aiProviders).values({
      workspaceId: ws,
      id: providerId,
      name: 'Fake',
      kind: 'openai-compatible',
      baseUrl: llm.baseUrl,
      models: { default: 'gpt-test' },
      useFor: ['journeys'],
      region: '',
      secrets: Buffer.from([0]),
      secretsKeyId: 'k_test',
      enabled: true,
    });
  });
  await publish('purposes', newId('pur'), 'Purposes', artifactTypes.purposes.content.parse({ purposes: legitimateInterestPurposes() }));
  await publish(
    'prompt',
    decidePrompt,
    'Decide',
    artifactTypes.prompt.content.parse({
      kind: 'decide',
      instructions: 'Pick one.',
      options: [
        { key: 'a', description: 'First' },
        { key: 'b', description: 'Second' },
      ],
    }),
  );
  await publish(
    'prompt',
    generatePrompt,
    'Cached text',
    artifactTypes.prompt.content.parse({
      kind: 'generate',
      instructions: 'Write a line.',
      slots: [{ name: 'subject', description: 'A subject', maxLength: 40, fallback: 'Hello' }],
      cache: { segments: [segmentId], ttlHours: 24 },
    }),
  );
  // The segment exists so the cache key can name it; only the survivor is a member.
  await d.db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.artifacts)
      .values({ workspaceId: ws, id: segmentId, type: 'segment', name: 'VIP', latestVersion: 1, publishedVersion: 1 }),
  );
}, 180_000);

afterAll(async () => {
  await llm?.close();
  await d?.close();
});

function legitimateInterestPurposes() {
  return DEFAULT_PURPOSES.map((p) =>
    p.key === 'ai_processing'
      ? { ...p, basis: 'legitimate_interest' as const, lia: { assessment: 'Test assessment', owner: 'DPO', reviewBy: '2027-01-01' } }
      : p,
  );
}

async function publish(type: 'purposes' | 'prompt', id: string, name: string, content: unknown) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({ workspaceId: ws, id, type, name, latestVersion: 1, publishedVersion: 1 });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: id,
      number: 1,
      state: 'published',
      content,
      contentHash: 'h',
      authorType: 'user',
      authorId: 'u_test',
    });
  });
}

/** Two people, the alias holding the identifier the queued call names. */
async function seedPair(traits: Record<string, unknown> = {}) {
  const survivor = newId('prf');
  const alias = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values([
      { workspaceId: ws, id: survivor, traits, createdAt: new Date(Date.UTC(2026, 9, 1)) },
      { workspaceId: ws, id: alias, createdAt: new Date(Date.UTC(2026, 9, 2)) },
    ]);
    await tx.insert(schema.identifiers).values([
      { workspaceId: ws, profileId: survivor, type: 'user_id', value: `user-${survivor}` },
      { workspaceId: ws, profileId: alias, type: 'anonymous_id', value: `anon-${alias}` },
    ]);
  });
  return { survivor, alias };
}

/** Queues one call as a journey leaves it: pending, waiting on the participant. */
async function queuedCall(profileId: string, kind: 'decide' | 'generate', promptId: string): Promise<CallRow> {
  return d.db.withWorkspace(ws, async (tx) => {
    const [participant] = await tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId: newId('jrn'),
        version: 1,
        profileId,
        entryKey: `test:${profileId}`,
        node: kind,
        seq: 1,
        status: 'waiting',
        dueAt: new Date(Date.UTC(2026, 9, 3)),
      })
      .returning({ id: schema.journeyParticipants.id });
    const [call] = await tx
      .insert(schema.aiCalls)
      .values({
        workspaceId: ws,
        id: newId('aic'),
        kind,
        status: 'pending',
        promptId,
        promptVersion: 1,
        participantId: participant!.id,
        node: kind,
        seq: 1,
        profileId,
        input: {},
      })
      .returning();
    return call!;
  });
}

/**
 * Runs the preparation with a merge of the alias into the survivor committed on another
 * connection right after the step's first consent read.
 */
async function prepareDuringMerge(call: CallRow, alias: string, survivor: string, object = false) {
  hooks.afterGate = () => mergeOnAnotherConnection(alias, survivor, object);
  try {
    return await d.db.withWorkspace(ws, (tx) => prepareCall(tx, call, { kp, events: { eventsOf: async () => [] } as never }));
  } finally {
    hooks.afterGate = undefined;
  }
}

async function mergeOnAnotherConnection(alias: string, survivor: string, object: boolean, survivorTraits?: Record<string, unknown>) {
  const conn = await d.db.admin.connect();
  try {
    await conn.query('BEGIN');
    if (survivorTraits) {
      // The survivor's trait snapshot is rewritten by a real merge; its updated_at is the revision
      // a preparation compares before and after the context build.
      await conn.query(`UPDATE profiles SET traits = traits || $3::jsonb, updated_at = now() WHERE workspace_id = $1 AND id = $2`, [
        ws,
        survivor,
        JSON.stringify(survivorTraits),
      ]);
    }
    await conn.query(
      `UPDATE profiles SET merged_into = $3, traits = '{}'::jsonb, pii = NULL, updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [ws, alias, survivor],
    );
    await conn.query('DELETE FROM consent_state WHERE workspace_id = $1 AND profile_id = $2', [ws, alias]);
    await conn.query('UPDATE identifiers SET profile_id = $3 WHERE workspace_id = $1 AND profile_id = $2', [ws, alias, survivor]);
    await conn.query('UPDATE journey_participants SET profile_id = $3 WHERE workspace_id = $1 AND profile_id = $2', [ws, alias, survivor]);
    await conn.query('INSERT INTO profile_merges (workspace_id, from_id, into_id, reason) VALUES ($1, $2, $3, $4)', [
      ws,
      alias,
      survivor,
      'test merge',
    ]);
    if (object) {
      await conn.query(
        `INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
         VALUES ($1, $2, 'ai_processing', '', 'objected', 'legitimate_interest', 'api', now())`,
        [ws, survivor],
      );
    }
    await conn.query('COMMIT');
  } finally {
    conn.release();
  }
}

describe.skipIf(!hasTestDatabase())('an AI step prepares for the person a merge leaves (#1300)', () => {
  it('reads the survivor’s traits when the merge lands while the decide context is built', async () => {
    const { survivor, alias } = await seedPair({ plan: 'survivor-plan' });
    const call = await queuedCall(alias, 'decide', decidePrompt);
    const prepared = await prepareDuringMerge(call, alias, survivor);
    // The merged-away row's traits are cleared, so a context built for it has none.
    expect((prepared as { person?: { traits: Record<string, unknown> } }).person?.traits).toMatchObject({
      plan: 'survivor-plan',
    });
  }, 60_000);

  it('keys the text cache by the survivor’s segments, not the empty set', async () => {
    const { survivor, alias } = await seedPair({ plan: 'survivor-plan' });
    await d.db.withWorkspace(ws, (tx) => tx.insert(schema.segmentMemberships).values({ workspaceId: ws, segmentId, profileId: survivor }));
    const call = await queuedCall(alias, 'generate', generatePrompt);
    const prepared = await prepareDuringMerge(call, alias, survivor);
    const ready = prepared as { cache?: { key: string }; person?: { segments?: string[] } };
    expect(ready.cache?.key).toBe(segmentId);
    expect(ready.person?.segments).toEqual(['VIP']);
  }, 60_000);

  it('falls back when the merge lands with the survivor objecting', async () => {
    const { survivor, alias } = await seedPair({ plan: 'survivor-plan' });
    const call = await queuedCall(alias, 'decide', decidePrompt);
    const prepared = await prepareDuringMerge(call, alias, survivor, true);
    expect((prepared as { fallback?: string }).fallback).toContain('no_lawful_basis');
  }, 60_000);

  it('keeps traits and event identifiers at the same revision when the root survives', async () => {
    // A profile merges INTO the survivor while the decide context is built: the traits are read
    // before the merge writes the survivor's union, the identifiers after it moved the alias's.
    // Both gate reads answer the same id, so only the survivor's revision can catch the mix.
    const { survivor, alias } = await seedPair({ revision: 'before' });
    const call = await queuedCall(survivor, 'decide', decidePrompt);
    planHook.afterTraits = () => mergeOnAnotherConnection(alias, survivor, false, { revision: 'after' });
    try {
      const prepared = await d.db.withWorkspace(ws, (tx) =>
        prepareCall(tx, call, {
          kp,
          events: {
            eventsOf: async (_workspace: string, ids: { anonymousIds: string[] }) =>
              ids.anonymousIds.includes(`anon-${alias}`)
                ? [{ name: 'Joined profile event', timestamp: new Date(Date.UTC(2026, 9, 2)).toISOString(), properties: {} }]
                : [],
          } as never,
        }),
      );
      const person = (prepared as unknown as { person: { traits: { revision: string }; recentEvents: unknown[] } }).person;
      // The state is rebuilt for the survivor after the merge, so the traits and the events that
      // identify the person come from the same revision.
      expect([person.traits.revision, person.recentEvents.length]).toEqual(['after', 1]);
    } finally {
      planHook.afterTraits = undefined;
    }
  }, 60_000);
});
