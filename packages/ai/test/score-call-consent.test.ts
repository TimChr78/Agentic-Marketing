import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

import { score } from '../src/score';
import { fakeSystemOne } from '../src/testing';

// #1300 review: a standalone ai.score read the person's consent before the model ran and then wrote
// its call row after the provider answered. When the person withdrew in between, the row still kept
// the answer, the state's fingerprint and size, and the provider's own model version, because the
// settlement only looked for erasure. The settlement now re-reads the gate under the identity and
// profile locks it writes behind, like the score write, and keeps only the billing fields on a
// refusal.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let decision: Awaited<ReturnType<typeof fakeSystemOne>>;
let ws: string;
const providerId = `aip_${'d'.repeat(32)}`;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_score_call_consent');
  kp = localKeyProvider(Buffer.alloc(32, 71).toString('base64'));
  ws = d.workspace;
  // The provider is asked after the gate allowed. The person withdraws while the model runs, before
  // the answer comes back, so the settlement sees a different consent than the request did.
  decision = await fakeSystemOne(async () => {
    await d.db.admin.query(
      `UPDATE consent_state SET status = 'objected', basis = 'legitimate_interest', updated_at = now()
       WHERE workspace_id = $1 AND purpose = 'ai_processing'`,
      [ws],
    );
    return { answers: { propensity: { type: 'noul', noul: 0.8 } }, model: 'provider-echo-9.9' };
  });
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake decisions', 'decision', $3, '{"default":"configured-model"}'::jsonb, ARRAY['decisions'], '', '\\x00'::bytea, 'k_test')`,
    [ws, providerId, decision.baseUrl],
  );
}, 180_000);

afterAll(async () => {
  await decision?.close();
  await d?.close();
});

async function seedPerson() {
  const id = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    await tx.insert(schema.consentState).values({
      workspaceId: ws,
      profileId: id,
      purpose: 'ai_processing',
      channel: '',
      status: 'granted',
      basis: 'consent',
      source: 'form',
      updatedAt: new Date(),
    });
  });
  return id;
}

const context = (tx: unknown) =>
  ({
    tx,
    principal: { workspaceId: ws, userId: 'u_test', permissions: new Set(['profiles:write']) },
    services: { db: d.db, keyProvider: kp, egress: { allowedHosts: ['127.0.0.1'] } },
  }) as never;

describe.skipIf(!hasTestDatabase())('a standalone score settlement re-checks consent before writing the call row (#1300 review)', () => {
  it('keeps only the billing fields when the person withdraws while the model runs', async () => {
    const person = await seedPerson();
    const result = await d.db.withWorkspace(ws, (tx) =>
      score.handler(
        {
          profileId: person,
          questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }],
          state: { plan: 'pro' },
          store: { key: 'in_flight', ttlHours: 168 },
        },
        context(tx),
      ),
    );

    // The caller still gets the answer it asked for; only the long-lived record is cleared.
    expect(result.answers[0]?.probability).toBe(0.8);
    // The score write has its own gate under the same locks, so nothing is stored either.
    expect(result.stored).toBeNull();

    const row = (
      await d.db.admin.query<{
        profile_id: string | null;
        status: string;
        input: Record<string, unknown>;
        output: unknown;
        error: string | null;
        model: string | null;
        latency_ms: number | null;
        principal_id: string | null;
        input_tokens: number;
        output_tokens: number;
      }>(
        `SELECT profile_id, status, input, output, error, model, latency_ms, principal_id, input_tokens, output_tokens
         FROM ai_calls WHERE workspace_id = $1 AND id = $2`,
        [ws, result.callId],
      )
    ).rows[0]!;
    // The row still names the person and keeps what billing needs; everything the request said
    // about the person — the state hash and size, the questions, the answers — is dropped, and the
    // provider's own model version is replaced by the configured one.
    expect(row).toMatchObject({
      profile_id: person,
      status: 'done',
      input: {},
      output: null,
      error: null,
      model: 'configured-model',
      latency_ms: null,
      principal_id: null,
    });
    expect(row.input_tokens).toBeGreaterThan(0);
    const scores = await d.db.admin.query('SELECT 1 FROM profile_scores WHERE workspace_id = $1 AND profile_id = $2', [ws, person]);
    expect(scores.rows).toEqual([]);
  }, 120_000);
});
