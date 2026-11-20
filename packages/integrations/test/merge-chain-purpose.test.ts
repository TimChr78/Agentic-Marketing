import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { purposeStillAllowed } from '../src/deliveries';

// #1093: the send-time purpose gate follows merges so it decides for the person who exists today.
// The old 20-hop walk treated a deeper chain as an erased profile, suppressing a queued webhook as
// if consent had been refused.

const HOPS = 25;
const chain = Array.from({ length: HOPS }, () => newId('prf'));
const survivor = chain[chain.length - 1]!;
const missing = newId('prf');

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('delivery_deep_merge_purpose');
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values(
      chain.map((id, i) => ({
        workspaceId: d.workspace,
        id,
        mergedInto: i < chain.length - 1 ? chain[i + 1]! : null,
      })),
    );
    // Consent lives on the survivor, as the merge moves it there.
    await tx.insert(schema.consentState).values({
      workspaceId: d.workspace,
      profileId: survivor,
      purpose: 'marketing_email',
      channel: 'email',
      status: 'granted',
      basis: 'consent',
      source: 'api',
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    });
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('send-time purpose gate on a deep merge chain (#1093)', () => {
  it(`allows a queued delivery for a person ${HOPS} merges deep`, async () => {
    const allowed = await d.db.withWorkspace(d.workspace, (tx) => purposeStillAllowed(tx, d.workspace, chain[0]!, 'marketing_email'));
    expect(allowed).toBe(true);
  }, 60_000);

  it('still suppresses a profile that no longer exists', async () => {
    const allowed = await d.db.withWorkspace(d.workspace, (tx) => purposeStillAllowed(tx, d.workspace, missing, 'marketing_email'));
    expect(allowed).toBe(false);
  }, 60_000);
});
