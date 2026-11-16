import { newId, newUuid } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import {
  assertNoProviderCalls,
  KeysChangedError,
  localKeyProvider,
  prepareKeys,
  recordingKeyProvider,
  withPreparedKeys,
} from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { personCrypto } from '../src/crypto';

// #978 part 1: keys are unwrapped before a protected transaction and only the memory-only
// provider is used inside it. A key that changes in between raises KeysChangedError, and the
// retry re-prepares instead of falling back to KMS/OpenBao.

const MASTER_KEY = Buffer.alloc(32, 11).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let recorder: ReturnType<typeof recordingKeyProvider>;
const p1 = newId('prf');
const p2 = newId('prf');
let sealed1: Buffer;
let sealed2: Buffer;

const unwraps = () => recorder.calls.filter((call) => call.method === 'unwrap').length;

/** Retires the active key of one purpose and inserts a fresh one, as a rotation would. */
async function rotateActive(purpose: 'identity' | 'matching') {
  const wrapped = await kp.wrap(Buffer.alloc(32, purpose === 'identity' ? 21 : 22));
  await d.db.admin.query('UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = $2 AND active', [d.workspace, purpose]);
  await d.db.admin.query(
    `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, purpose, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [d.workspace, newId('dk'), kp.id, wrapped, purpose],
  );
}

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('prepared_keys');
  kp = localKeyProvider(MASTER_KEY);
  recorder = recordingKeyProvider(kp);
  const seeded = await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values([
      { workspaceId: d.workspace, id: p1 },
      { workspaceId: d.workspace, id: p2 },
    ]);
    const crypto = personCrypto(tx, d.workspace, kp);
    const s1 = await crypto.seal(p1, { name: 'Ada' });
    const s2 = await crypto.seal(p2, { name: 'Grace' });
    await crypto.matchHash('email', 'ada@example.com');
    return { s1, s2 };
  });
  sealed1 = seeded.s1;
  sealed2 = seeded.s2;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('prepared keys (#978 part 1)', () => {
  it('unwraps exactly the distinct data keys the batch needs', async () => {
    recorder.reset();
    const prepared = await prepareKeys(d.db, d.workspace, recorder, { profileIds: [p1, p2] });
    // One active identity key (shared by both profile keys) and one active matching key.
    expect(prepared.dataKeyIds).toHaveLength(2);
    expect(unwraps()).toBe(2);
    expect(prepared.profileIds).toEqual([p1, p2]);
  });

  it('makes no provider call inside a protected transaction', async () => {
    const prepared = await prepareKeys(d.db, d.workspace, recorder, { profileIds: [p1, p2] });
    recorder.reset();
    const seen = await assertNoProviderCalls(recorder, () =>
      d.db.withWorkspace(d.workspace, async (tx) => {
        const crypto = personCrypto(tx, d.workspace, prepared.provider);
        return {
          one: await crypto.open<{ name: string }>(p1, sealed1),
          two: await crypto.open<{ name: string }>(p2, sealed2),
          hash: await crypto.matchHash('email', 'grace@example.com'),
        };
      }),
    );
    expect(seen.one).toEqual({ name: 'Ada' });
    expect(seen.two).toEqual({ name: 'Grace' });
    expect(seen.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorder.calls).toHaveLength(0);
  });

  it('raises a retryable KeysChangedError when a key is rotated between preparation and use', async () => {
    const prepared = await prepareKeys(d.db, d.workspace, recorder, { profileIds: [p1] });
    await rotateActive('matching');
    recorder.reset();
    const error = await d.db
      .withWorkspace(d.workspace, (tx) => personCrypto(tx, d.workspace, prepared.provider).matchHash('email', 'rotated@example.com'))
      .catch((e) => e);
    expect(error).toBeInstanceOf(KeysChangedError);
    expect(error.retryable).toBe(true);
    // It did not fall back to the configured provider: zero calls after preparation.
    expect(recorder.calls).toHaveLength(0);
  });

  it('withPreparedKeys re-prepares and succeeds after a rotation', async () => {
    let preparations = 0;
    const result = await withPreparedKeys(
      async () => {
        const prepared = await prepareKeys(d.db, d.workspace, recorder, { profileIds: [p2] });
        preparations++;
        // Rotate after the first preparation, between prepare and run.
        if (preparations === 1) await rotateActive('matching');
        return prepared;
      },
      (prepared) =>
        d.db.withWorkspace(d.workspace, (tx) => personCrypto(tx, d.workspace, prepared.provider).matchHash('email', 'again@example.com')),
      { attempts: 2 },
    );
    expect(preparations).toBe(2);
    const expected = await d.db.withWorkspace(d.workspace, (tx) =>
      personCrypto(tx, d.workspace, kp).matchHash('email', 'again@example.com'),
    );
    expect(result).toBe(expected);
  });

  it('raises KeysChangedError for a key missing from the prepared set without calling the provider', async () => {
    // Only the matching key is prepared; opening a profile needs its identity key.
    const prepared = await prepareKeys(d.db, d.workspace, recorder, { purposes: ['matching'] });
    recorder.reset();
    const error = await d.db
      .withWorkspace(d.workspace, (tx) => personCrypto(tx, d.workspace, prepared.provider).open(p1, sealed1))
      .catch((e) => e);
    expect(error).toBeInstanceOf(KeysChangedError);
    expect(recorder.calls).toHaveLength(0);
  });

  it('provisions missing active keys in a short transaction before the protected block', async () => {
    const fresh = newUuid();
    await d.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [fresh, 'Prepared keys', 'none']);
    recorder.reset();
    const prepared = await prepareKeys(d.db, fresh, recorder, { purposes: ['identity', 'matching'] });
    expect(prepared.dataKeyIds).toHaveLength(2);
    const active = await d.db.admin.query<{ purpose: string }>(
      'SELECT purpose FROM data_keys WHERE workspace_id = $1 AND active ORDER BY purpose',
      [fresh],
    );
    expect(active.rows.map((r) => r.purpose)).toEqual(['identity', 'matching']);
    recorder.reset();
    const hash = await assertNoProviderCalls(recorder, () =>
      d.db.withWorkspace(fresh, (tx) => personCrypto(tx, fresh, prepared.provider).matchHash('email', 'fresh@example.com')),
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
