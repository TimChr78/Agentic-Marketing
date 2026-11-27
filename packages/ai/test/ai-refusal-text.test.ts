import { artifactTypes } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { classify } from '../src/classify';
import { score } from '../src/score';

// #1300: ai.classify and ai.score answered "no profile" and "consent refused" differently, so a
// caller who may only write profiles could tell whether a person exists (and was erased) from the
// refusal text alone. Both commands answer one public refusal for an unknown, an erased and a
// refusing person; the detailed reason stays in the logs and the audit trail.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;
const promptId = newId('prm');

type Failure = { code?: string; message?: string };

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_refusal_text');
  ws = d.workspace;
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: ws,
      id: promptId,
      type: 'prompt',
      name: 'Reply intent',
      latestVersion: 1,
      publishedVersion: 1,
    });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: promptId,
      number: 1,
      state: 'published',
      content: artifactTypes.prompt.content.parse({
        kind: 'classify',
        instructions: 'Label the reply.',
        options: [
          { key: 'question', description: 'Asks something' },
          { key: 'other', description: 'Anything else' },
        ],
        trait: 'reply_intent',
      }),
      contentHash: 'h',
      authorType: 'user',
      authorId: 'u_test',
    });
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function seed(status: 'granted' | 'objected') {
  const id = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    await tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId: id,
      purpose: 'ai_processing',
      channel: '',
      status,
      basis: status === 'granted' ? 'consent' : 'legitimate_interest',
      source: 'form',
      updatedAt: new Date(),
    });
  });
  return id;
}

async function erased() {
  const id = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    await tx.delete(schema.profiles).where(and(eq(schema.profiles.workspaceId, ws), eq(schema.profiles.id, id)));
  });
  return id;
}

const context = (tx: unknown) =>
  ({
    tx,
    principal: { workspaceId: ws, userId: 'u_test', permissions: new Set(['profiles:write']) },
    services: { db: d.db, keyProvider: undefined },
  }) as never;

const classifyFailure = (profileId: string): Promise<Failure> =>
  d.db
    .withWorkspace(ws, (tx) => classify.handler({ artifactId: promptId, text: 'Where is my order?', profileId }, context(tx)))
    .then(
      () => ({}) as Failure,
      (err: Failure) => err,
    );

const scoreFailure = (profileId: string): Promise<Failure> =>
  d.db
    .withWorkspace(ws, (tx) =>
      score.handler(
        { profileId, questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }], state: { plan: 'pro' } },
        context(tx),
      ),
    )
    .then(
      () => ({}) as Failure,
      (err: Failure) => err,
    );

describe.skipIf(!hasTestDatabase())('an AI refusal does not reveal whether a profile exists (#1300)', () => {
  it('answers one refusal for an unknown, an erased and an objecting person in ai.classify', async () => {
    const knowable = new Set<string>();
    for (const id of [newId('prf'), await erased(), await seed('objected')]) {
      const failure = await classifyFailure(id);
      expect(failure.code).toBe('forbidden');
      knowable.add(String(failure.message));
      // Neither the internal reason nor the person's id reaches the caller.
      expect(failure.message).not.toContain('no_profile');
      expect(failure.message).not.toContain('no_lawful_basis');
      expect(failure.message).not.toContain(id);
    }
    expect([...knowable]).toHaveLength(1);
  }, 60_000);

  it('answers the same refusal from ai.score', async () => {
    const knowable = new Set<string>();
    for (const id of [newId('prf'), await erased(), await seed('objected')]) {
      const failure = await scoreFailure(id);
      expect(failure.code).toBe('forbidden');
      knowable.add(String(failure.message));
      expect(failure.message).not.toContain('no_profile');
      expect(failure.message).not.toContain('no_lawful_basis');
      expect(failure.message).not.toContain(id);
    }
    expect([...knowable]).toHaveLength(1);
    // The gate still allows a person who granted, so the promise above is about refusals only.
    const granted = await seed('granted');
    const allowed = await d.db
      .withWorkspace(ws, (tx) =>
        score.handler(
          {
            profileId: granted,
            questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }],
            state: { plan: 'pro' },
          },
          context(tx),
        ),
      )
      .catch((err: Failure) => err as never);
    // No provider is configured in this workspace: the command gets past the gate and fails later.
    expect(allowed).not.toMatchObject({ code: 'forbidden' });
  }, 60_000);
});
