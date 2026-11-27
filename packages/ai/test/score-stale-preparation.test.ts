import { canonicalProfileId } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { lockCanonicalProfile } from '../src/decision';
import { consentCheckedScoreProfile } from '../src/score';

// #1269 review: a merge that commits between the score's first profile read and its consent
// lookup could make the survivor's consent look absent (a false `no_lawful_basis`), and the
// canonical lookup before the score lock could drop a score when a merge landed between its two
// statements. The consent check re-resolves once, and the lock resolves through the
// single-statement lookup.

describe('the score lock resolves and locks through one canonical lookup (#1269 review)', () => {
  it('follows the survivor when a merge lands between the canonical read and the lock', async () => {
    // The fake answers each statement as the database would while a merge commits between the
    // lookup and the lock: the first lock finds the root already merged and locks nothing, so the
    // helper must resolve again and lock the survivor (#1283 re-check).
    const answers = [
      { rows: [{ origin: 'prf_alias', id: 'prf_root', merged_into: null }] }, // canonical lookup
      { rows: [] }, // lock prf_root: merged meanwhile, nothing locked
      { rows: [{ origin: 'prf_root', id: 'prf_survivor', merged_into: null }] }, // lookup again
      { rows: [{ id: 'prf_survivor' }] }, // lock the survivor
    ];
    let calls = 0;
    const tx = {
      execute: async () => {
        const answer = answers[calls];
        calls += 1;
        if (!answer) throw new Error(`unexpected statement ${calls}`);
        return answer;
      },
    } as unknown as Tx;

    await expect(lockCanonicalProfile(tx, 'ws_test', 'prf_alias')).resolves.toBe('prf_survivor');
    expect(calls).toBe(4);
  });
});

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_stale_preparation');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('score consent re-resolves once when a merge moves the person (#1269 review)', () => {
  it('uses the survivor’s consent instead of falling back with no_lawful_basis', async () => {
    const alias = newId('prf');
    const survivor = newId('prf');
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values([
        { workspaceId: ws, id: alias },
        { workspaceId: ws, id: survivor },
      ]);
      // Only the survivor has an AI-consent record; the person whose profile was folded into it had
      // its rows moved by the merge, which is what makes the stale lookup say "no record".
      await tx.insert(schema.consentState).values({
        workspaceId: ws,
        profileId: survivor,
        purpose: 'ai_processing',
        channel: '',
        status: 'granted',
        basis: 'consent',
        source: 'form',
        updatedAt: new Date('2026-11-01T00:00:00Z'),
      });
    });

    const resolved = await d.db.withWorkspace(ws, async (tx) => {
      // The score resolves the person in one statement, and the merge then commits before the
      // consent read — the window the retry covers.
      const first = await canonicalProfileId(tx, ws, alias);
      expect(first).toBe(alias);
      await tx.execute(sql`UPDATE profiles SET merged_into = ${survivor} WHERE workspace_id = ${ws} AND id = ${alias}`);
      return consentCheckedScoreProfile(tx, ws, first!);
    });

    expect(resolved).toBe(survivor);
  }, 120_000);

  it('still refuses when nobody in the family allows AI processing', async () => {
    const person = newId('prf');
    await d.db.withWorkspace(ws, (tx) => tx.insert(schema.profiles).values({ workspaceId: ws, id: person }));
    await expect(d.db.withWorkspace(ws, (tx) => consentCheckedScoreProfile(tx, ws, person))).rejects.toMatchObject({ code: 'forbidden' });
  }, 120_000);
});
