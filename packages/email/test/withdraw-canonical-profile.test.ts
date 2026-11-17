import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { canonicalProfile } from '@agentic-marketing/profiles';
import { localKeyProvider, recordingKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { type Msg, withdraw } from '../src/deliveryEvents';

// #978 part 1: recording an unsubscribe needs the canonical profile id, not decrypted personal
// data. The lookup is SQL only, so a withdrawal makes no key-provider call and can later run
// under the identity lock.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let recorder: ReturnType<typeof recordingKeyProvider>;
const survivor = newId('prf');
const alias = newId('prf');
const missing = newId('prf');

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('withdraw_canonical');
  recorder = recordingKeyProvider(localKeyProvider(Buffer.alloc(32, 13).toString('base64')));
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values([
      { workspaceId: d.workspace, id: survivor },
      { workspaceId: d.workspace, id: alias, mergedInto: survivor },
    ]);
    await tx.insert(schema.profileMerges).values({
      workspaceId: d.workspace,
      fromId: alias,
      intoId: survivor,
      reason: 'test merge',
    });
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('withdrawal on a merged-away message profile (#978 part 1)', () => {
  it('resolves the canonical profile from SQL only', async () => {
    await expect(d.db.withWorkspace(d.workspace, (tx) => canonicalProfile(tx, d.workspace, alias))).resolves.toEqual({
      id: survivor,
    });
    await expect(d.db.withWorkspace(d.workspace, (tx) => canonicalProfile(tx, d.workspace, missing))).resolves.toBeNull();
  });

  it('records the withdrawal on the survivor without calling the key provider', async () => {
    const messageId = newId('msg');
    const msg = {
      workspaceId: d.workspace,
      id: messageId,
      profileId: alias,
      purpose: 'marketing_email',
      channel: 'email',
    } as Msg;

    recorder.reset();
    await d.db.withWorkspace(d.workspace, (tx) =>
      withdraw(tx, msg, 'unsubscribe', { via: 'test' }, new Date('2026-01-02T03:04:05Z'), 'evt-withdrawal'),
    );

    expect(recorder.calls).toHaveLength(0);
    const records = await d.db.admin.query<{ profile_id: string; status: string; message_id: string }>(
      'SELECT profile_id, status, message_id FROM consent_records WHERE workspace_id = $1 ORDER BY id',
      [d.workspace],
    );
    expect(records.rows).toEqual([{ profile_id: survivor, status: 'withdrawn', message_id: 'evt-withdrawal' }]);
    const state = await d.db.admin.query<{ profile_id: string; status: string }>(
      'SELECT profile_id, status FROM consent_state WHERE workspace_id = $1',
      [d.workspace],
    );
    expect(state.rows).toEqual([{ profile_id: survivor, status: 'withdrawn' }]);
  });
});
