import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('../src/context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/context')>();
  return { ...original, aiAllowed: vi.fn(original.aiAllowed) };
});

import { aiAllowed } from '../src/context';
import { answerSteps } from '../src/steps';

// A robust refusal is a stable answer: the decision step used to hand the retry wrapper a null id
// on every refusal, so the wrapper thought the person had moved and re-ran the gate for each
// attempt. The refusal now carries the id it answered for, and the wrapper stops when it has not
// changed.

const gate = vi.mocked(aiAllowed);
const kp = localKeyProvider(Buffer.alloc(32, 66).toString('base64'));

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let workspace: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_steps_refusal_retry');
  workspace = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const noul = { key: 'propensity', type: 'noul' as const, instructions: 'Will this person convert?' };

describe.skipIf(!hasTestDatabase())('a refused decision step asks the gate once', () => {
  it('keeps a stable refusal from being re-run by the retry wrapper', async () => {
    const person = newId('prf');
    await d.db.withWorkspace(workspace, async (tx) => {
      await tx.insert(schema.profiles).values({ workspaceId: workspace, id: person });
      await tx.insert(schema.consentState).values({
        workspaceId: workspace,
        profileId: person,
        purpose: 'ai_processing',
        status: 'objected',
        basis: 'legitimate_interest',
        source: 'api',
        updatedAt: new Date('2026-11-01T00:00:00Z'),
      });
      const [participant] = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId: workspace,
          journeyId: newId('jrn'),
          version: 1,
          profileId: person,
          entryKey: `test:${person}`,
          node: 'decide',
          seq: 1,
          status: 'waiting',
          dueAt: new Date('2026-11-02T00:00:00Z'),
        })
        .returning({ id: schema.journeyParticipants.id });
      await tx.insert(schema.aiCalls).values({
        workspaceId: workspace,
        id: newId('aic'),
        kind: 'score',
        status: 'pending',
        participantId: participant!.id,
        node: 'decide',
        seq: 1,
        profileId: person,
        input: { questions: [noul], scoreKey: 'propensity' },
      });
    });

    gate.mockClear();
    expect(
      await answerSteps(d.db, {
        kp,
        events: { eventsOf: async () => [] } as never,
        egress: { allowedHosts: ['127.0.0.1'] },
      }),
    ).toBe(1);

    expect(gate).toHaveBeenCalledTimes(1);
  }, 60_000);
});
