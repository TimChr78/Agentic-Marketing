import type { Tx } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { storeClassifiedTrait } from '../src/steps';

// The classify worker used to resolve the call's person, write the label and report the trait
// whether or not the UPDATE matched a row, and it did not re-check consent under that write. A
// merge between the consent check and the write could therefore move the label onto a profile that
// had not allowed it, or report a trait that was never stored. The write now locks the person the
// call was checked for, re-checks consent there, and reports the trait only when a row changed.

type Answer = { rows: unknown[]; rowCount?: number };

/**
 * A transaction whose statements answer a fixed sequence: the identity lock, the lock's canonical
 * lookup and row lock, the gate's single person-and-consent read, then the UPDATE. Any extra
 * statement fails the test, so a re-resolve or a duplicated gate call is visible.
 */
function fakeTx(answers: Answer[]) {
  const state = { executes: 0 };
  const tx = {
    execute: async () => {
      const answer = answers[state.executes];
      state.executes += 1;
      if (!answer) throw new Error(`unexpected statement ${state.executes}`);
      return answer;
    },
    select: () => ({
      from: () => {
        const done = async () => [];
        const chain = { where: done, innerJoin: () => chain };
        return chain;
      },
    }),
  } as unknown as Tx;
  return { tx, state };
}

const identity = { rows: [] };
const person = 'prf_person';
const canonical = { rows: [{ origin: 'prf_checked', id: person, merged_into: null }] };
const locked = { rows: [{ id: person }] };
const gate = (status: string) => ({
  rows: [{ origin: person, id: person, merged_into: null, status, updated_at: '2026-01-01T00:00:00.000Z' }],
});

describe('the classify trait write reports only what it stored', () => {
  it('returns no trait when the locked person no longer allowed AI processing', async () => {
    const { tx, state } = fakeTx([identity, canonical, locked, gate('objected')]);
    await expect(storeClassifiedTrait(tx, 'ws_test', 'prf_checked', 'reply_intent', 'question')).resolves.toBeNull();
    // The gate refused, so the UPDATE must not have run (an extra answer would throw).
    expect(state.executes).toBe(4);
  });

  it('returns no trait when the UPDATE matched no row', async () => {
    const { tx, state } = fakeTx([identity, canonical, locked, gate('granted'), { rows: [], rowCount: 0 }]);
    await expect(storeClassifiedTrait(tx, 'ws_test', 'prf_checked', 'reply_intent', 'question')).resolves.toBeNull();
    expect(state.executes).toBe(5);
  });

  it('returns the trait when the label was written', async () => {
    const { tx, state } = fakeTx([identity, canonical, locked, gate('granted'), { rows: [], rowCount: 1 }]);
    await expect(storeClassifiedTrait(tx, 'ws_test', 'prf_checked', 'reply_intent', 'question')).resolves.toBe('reply_intent');
    expect(state.executes).toBe(5);
  });
});
