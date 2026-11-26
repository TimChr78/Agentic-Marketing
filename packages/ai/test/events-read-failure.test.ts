import { artifactTypes } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

// #1242: the journey AI and decision context builders turned a rejected `eventsOf` into an empty
// history, so the model decided or wrote for a person it was told did nothing, the step was
// recorded `done` and the tokens were billed. A failed read must propagate (the #360 rule), leave
// the call for its next attempt, and call nothing.

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  // Only the provider key is opened on this path; nothing else about the key provider matters here.
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

import { localKeyProvider } from '@agentic-marketing/secrets';
import { nonPersonalState } from '../src/decision';
import { answerSteps } from '../src/steps';
import { fakeLlm } from '../src/testing';

const MASTER_KEY = Buffer.alloc(32, 63).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let llm: Awaited<ReturnType<typeof fakeLlm>>;
let ws = '';
const promptId = `prm_${'1'.repeat(32)}`;
const providerId = `aip_${'2'.repeat(32)}`;
const profileId = newId('prf');
const callId = `aic_${'3'.repeat(32)}`;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_events_swallowed');
  ws = d.workspace;
  llm = await fakeLlm(() => ({
    text: JSON.stringify({ option: 'a', rationale: 'No recent activity.' }),
    inputTokens: 50,
    outputTokens: 7,
  }));
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake', 'openai-compatible', $3, '{"default":"gpt-test"}'::jsonb, ARRAY['journeys'], '', '\\x00'::bytea, 'k_test')`,
    [ws, providerId, llm.baseUrl],
  );
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id: profileId });
    await tx.insert(schema.identifiers).values({ workspaceId: ws, profileId, type: 'user_id', value: `user-${profileId}` });
    await tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId,
      purpose: 'ai_processing',
      status: 'granted',
      basis: 'consent',
      source: 'import',
      updatedAt: new Date(),
    });
    await tx
      .insert(schema.artifacts)
      .values({ workspaceId: ws, id: promptId, type: 'prompt', name: 'Decide', latestVersion: 1, publishedVersion: 1 });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: promptId,
      number: 1,
      state: 'published',
      content: artifactTypes.prompt.content.parse({
        kind: 'decide',
        instructions: 'Pick one.',
        options: [
          { key: 'a', description: 'First' },
          { key: 'b', description: 'Second' },
        ],
      }),
      contentHash: 'h',
      authorType: 'user',
      authorId: 'u_test',
    });
    const [participant] = await tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId: newId('jrn'),
        version: 1,
        profileId,
        entryKey: `test:${profileId}`,
        node: 'decide',
        seq: 1,
        status: 'waiting',
        dueAt: new Date(Date.UTC(2026, 0, 3)),
      })
      .returning({ id: schema.journeyParticipants.id });
    await tx.insert(schema.aiCalls).values({
      workspaceId: ws,
      id: callId,
      kind: 'decide',
      status: 'pending',
      promptId,
      promptVersion: 1,
      participantId: participant!.id,
      node: 'decide',
      seq: 1,
      profileId,
      input: {},
    });
  });
}, 120_000);

afterAll(async () => {
  await llm?.close();
  await d?.close();
});

const failingEvents = () => ({
  // ClickHouse is restarting: the read fails, it does not return an empty history.
  eventsOf: async () => {
    throw new Error('ClickHouse is down for maintenance');
  },
});

describe.skipIf(!hasTestDatabase())('a failed event read is not an empty history (#1242)', () => {
  it('leaves the journey AI step for a retry instead of calling the model blind', async () => {
    const events = failingEvents();
    const handled = await answerSteps(d.db, {
      kp: localKeyProvider(MASTER_KEY),
      events: events as never,
      egress: { allowedHosts: ['127.0.0.1'] },
    });
    expect(handled).toBe(1);

    // No model call, no tokens, no answer: the read failure is not a reason to decide.
    expect(llm.requests).toHaveLength(0);
    let [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));
    expect(call!.status).toBe('running');
    expect(call!.error).toBeNull();
    expect(call!.inputTokens).toBe(0);
    const [participant] = (
      await d.db.admin.query<{ context: Record<string, unknown> }>(
        'SELECT context FROM journey_participants WHERE workspace_id = $1 AND profile_id = $2',
        [ws, profileId],
      )
    ).rows;
    expect(participant!.context.ai).toBeUndefined();

    // The lease retries it, and the retry budget still ends after three attempts (#941 shape).
    for (let attempt = 0; attempt < 3; attempt++) {
      await d.db.admin.query(`UPDATE ai_calls SET lease_until = now() - interval '1 second' WHERE workspace_id = $1 AND id = $2`, [
        ws,
        callId,
      ]);
      await answerSteps(d.db, { kp: localKeyProvider(MASTER_KEY), events: events as never, egress: { allowedHosts: ['127.0.0.1'] } });
    }
    [call] = await d.db.withWorkspace(ws, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, callId)));
    expect(call!.status).toBe('failed');
    expect(call!.error).toContain('gave up after 3 attempts');
    expect(llm.requests).toHaveLength(0);
  }, 60_000);

  it('nonPersonalState propagates the read failure instead of reporting no events', async () => {
    await expect(d.db.withWorkspace(ws, (tx) => nonPersonalState(tx, ws, failingEvents() as never, profileId))).rejects.toThrow(
      'ClickHouse is down for maintenance',
    );
  }, 60_000);
});
