import { artifactTypes } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { answerSteps } from '../src/steps';

// #1300 review: a decide or generate step can find the person's objection while it prepares, before
// the model runs. That path used to finish with a plain fallback string, so finalisation did not
// know it was a refusal and left the trigger event's properties in `ai_calls`. The preparation now
// carries a typed refusal into finalisation, which clears the person-derived input like any other
// refusal.

type Stack = Awaited<ReturnType<typeof createDisposableDb>>;

let d: Stack;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
const promptId = newId('prm');

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_steps_preparation_refusal');
  kp = localKeyProvider(Buffer.alloc(32, 66).toString('base64'));
  ws = d.workspace;
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: ws,
      id: promptId,
      type: 'prompt',
      name: 'Decide',
      latestVersion: 1,
      publishedVersion: 1,
    });
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
  });
}, 180_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('a preparation-time refusal clears the trigger properties (#1300)', () => {
  it('keeps only the trigger name when the gate refuses before the model runs', async () => {
    const person = newId('prf');
    const { participantId, callId } = await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values({ workspaceId: ws, id: person });
      await tx.insert(schema.consentState).values({
        workspaceId: ws,
        profileId: person,
        purpose: 'ai_processing',
        channel: '',
        status: 'objected',
        basis: 'consent',
        source: 'api',
        updatedAt: new Date(Date.UTC(2026, 9, 1)),
      });
      const [participant] = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: ws,
          journeyId: newId('jrn'),
          version: 1,
          profileId: person,
          entryKey: `test:${person}`,
          node: 'decide',
          seq: 1,
          status: 'waiting',
          dueAt: new Date(Date.UTC(2026, 9, 2)),
        })
        .returning({ id: schema.journeyParticipants.id });
      const id = newId('aic');
      await tx.insert(schema.aiCalls).values({
        workspaceId: ws,
        id,
        kind: 'decide',
        status: 'pending',
        promptId,
        promptVersion: 1,
        participantId: participant!.id,
        node: 'decide',
        seq: 1,
        profileId: person,
        // What a journey step records: the event that started it, properties included.
        input: { trigger: { name: 'Order Completed', properties: { email: 'ada@example.com' } } },
      });
      return { participantId: participant!.id, callId: id };
    });

    expect(
      await answerSteps(d.db, {
        kp,
        events: { eventsOf: async () => [] } as never,
        egress: { allowedHosts: ['127.0.0.1'] },
      }),
    ).toBe(1);

    const settled = (
      await d.db.admin.query<{ status: string; error: string | null; output: unknown; input: Record<string, unknown> }>(
        'SELECT status, error, output, input FROM ai_calls WHERE workspace_id = $1 AND id = $2',
        [ws, callId],
      )
    ).rows[0]!;
    // No model ran, so there is nothing to bill; the refusal is recorded as the fallback reason.
    expect(settled).toMatchObject({ status: 'fallback', output: null });
    expect(settled.error).toContain('no_lawful_basis');
    // The trigger's name is step configuration; its properties are about the person.
    expect(settled.input.trigger).toEqual({ name: 'Order Completed' });
    expect(JSON.stringify(settled.input)).not.toContain('ada@example.com');

    const participant = (
      await d.db.admin.query<{ status: string; context: { ai?: { decide?: Record<string, unknown> } } }>(
        'SELECT status, context FROM journey_participants WHERE workspace_id = $1 AND id = $2',
        [ws, participantId],
      )
    ).rows[0]!;
    expect(participant.status).toBe('waiting');
    expect(participant.context.ai?.decide?.fallback).toContain('no_lawful_basis');
    expect(participant.context.ai?.decide?.option).toBeUndefined();
    expect(participant.context.ai?.decide?.probability).toBeUndefined();
  }, 120_000);
});
