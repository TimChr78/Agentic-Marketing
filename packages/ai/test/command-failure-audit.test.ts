import { createExecutor, userPrincipal } from '@agentic-marketing/commands';
import { newId } from '@agentic-marketing/core';
import { createDb, schema } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  return { ...original, openJson: async () => ({ apiKey: 'sk-test' }) };
});

import { score } from '../src/score';
import { fakeSystemOne } from '../src/testing';

// #1300: a decision provider may quote the request — and so a person's data — in its failure
// message. The caller keeps its own copy, but the audit log (and the agent ledger, through the same
// stored text) must not keep the provider's words.

const ECHO = 'cannot score Ada Lovelace at ada@example.com';
const FIXED = 'the AI provider refused or failed';

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let db: ReturnType<typeof createDb>;
let kp: ReturnType<typeof localKeyProvider>;
let decision: Awaited<ReturnType<typeof fakeSystemOne>>;
let ws: string;
const providerId = `aip_${'c'.repeat(32)}`;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_failure_audit');
  db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 4 });
  kp = localKeyProvider(Buffer.alloc(32, 69).toString('base64'));
  ws = d.workspace;
  decision = await fakeSystemOne(() => ({ status: 422, error: ECHO }));
  await d.db.admin.query(
    `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region, secrets, secrets_key_id)
     VALUES ($1, $2, 'Fake decisions', 'decision', $3, '{"default":"jev-test-1.0.0"}'::jsonb, ARRAY['decisions'], '', '\\x00'::bytea, 'k_test')`,
    [ws, providerId, decision.baseUrl],
  );
}, 180_000);

afterAll(async () => {
  await decision?.close();
  await db?.close();
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

describe.skipIf(!hasTestDatabase())('a failed ai.score keeps a fixed diagnostic in the audit log (#1300)', () => {
  it('stores the error code and a fixed text, never the provider’s echo', async () => {
    const person = await seedPerson();
    const executor = createExecutor(db, {
      serverVersion: 'test',
      strictInputs: false,
      db,
      keyProvider: kp,
      egress: { allowedHosts: ['127.0.0.1'] },
    } as never);
    const failure = await executor
      .execute(
        score,
        {
          profileId: person,
          questions: [{ key: 'propensity', type: 'noul', instructions: 'Will this person convert?' }],
          state: { plan: 'pro' },
        },
        userPrincipal('usr_failure', ws, 'owner'),
        { surface: 'rest' },
      )
      .then(
        () => ({ code: undefined, message: '' }),
        (err: { code?: string; message?: string }) => err,
      );
    expect(failure.code).toBe('conflict');

    const { rows } = await db.admin.query<{ error: string | null }>(
      'SELECT error FROM audit_log WHERE workspace_id = $1 AND command = $2 ORDER BY seq DESC',
      [ws, 'ai.score'],
    );
    expect(rows[0]?.error).toBe(`conflict: ${FIXED}`);
    expect(rows.map((r) => r.error ?? '').join(' ')).not.toContain('ada@example.com');
    expect(rows.map((r) => r.error ?? '').join(' ')).not.toContain('Ada Lovelace');
  }, 120_000);
});
