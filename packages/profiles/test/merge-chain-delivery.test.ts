import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { canonicalProfile, personCrypto, profileForMessage } from '../src';

// #1071: delivery resolves a person through the shared merge component (256 hops, cycle-safe), not
// the old 20-hop walk. A person 21 merges deep must still receive their mail.

const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
const HOPS = 25;

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
const chain = Array.from({ length: HOPS }, () => newId('prf'));
const terminal = chain[chain.length - 1]!;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('merge_chain_delivery');
  kp = localKeyProvider(MASTER_KEY);
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values(
      chain.map((id, i) => ({
        workspaceId: d.workspace,
        id,
        mergedInto: i < chain.length - 1 ? chain[i + 1]! : null,
        traits: i === chain.length - 1 ? { firstName: 'Ada' } : {},
      })),
    );
    const crypto = personCrypto(tx, d.workspace, kp);
    const value = 'ada@example.test';
    await tx.insert(schema.identifiers).values({
      workspaceId: d.workspace,
      profileId: terminal,
      type: 'email',
      value: await crypto.matchHash('email', value),
      valueEnc: await crypto.seal(terminal, value),
    });
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('deep merge chains in delivery (#1071)', () => {
  it(`follows a merge chain longer than 20 hops to the person at the end (${HOPS} hops)`, async () => {
    const person = await d.db.withWorkspace(d.workspace, (tx) => profileForMessage(tx, d.workspace, chain[0]!, kp));
    expect(person).toMatchObject({ id: terminal, email: 'ada@example.test', vars: { firstName: 'Ada' } });

    await expect(d.db.withWorkspace(d.workspace, (tx) => canonicalProfile(tx, d.workspace, chain[0]!))).resolves.toEqual({
      id: terminal,
    });
  });
});
