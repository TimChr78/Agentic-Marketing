import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { canonicalOf } from '../src/audiences';

// #1093: static audience selectors resolve through the shared merge walk (256 hops, cycle-safe),
// so a person 21+ merges deep can be added to a list instead of being reported as not found.

const HOPS = 25;
const chain = Array.from({ length: HOPS }, () => newId('prf'));
const survivor = chain[chain.length - 1]!;

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('segments_deep_merge_selector');
  await d.db.withWorkspace(d.workspace, (tx) =>
    tx.insert(schema.profiles).values(
      chain.map((id, i) => ({
        workspaceId: d.workspace,
        id,
        mergedInto: i < chain.length - 1 ? chain[i + 1]! : null,
      })),
    ),
  );
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('static audience selector on a deep merge chain (#1093)', () => {
  it(`resolves a selector ${HOPS} merges deep to the survivor`, async () => {
    const resolved = await d.db.withWorkspace(d.workspace, (tx) => canonicalOf(tx, d.workspace, [chain[0]!, newId('prf')]));

    expect(resolved.get(chain[0]!)).toBe(survivor);
    // A profile that does not exist still resolves to nothing.
    expect([...resolved.values()]).toContain(null);
  }, 60_000);
});
