import type { Tx } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { aiAllowed, prepareForPerson } from '../src/context';

// #1300: a merge can change the surviving person's effective consent without changing the id a
// caller already holds (a profile folded into it keeps the survivor's id). A preparation that read
// the gate, built person-derived state and then used it would send or store that state under an
// answer that no longer holds. `prepareForPerson` reads the gate again after the build, discards
// the build when the answer changed, and redoes it for the person the merge left.

/** A transaction whose gate reads answer a fixed sequence; anything else is a test bug. */
function fakeTx(answers: { rows: unknown[] }[]) {
  const state = { executes: 0 };
  const tx = {
    execute: async () => {
      const answer = answers[state.executes];
      state.executes += 1;
      if (!answer) throw new Error(`unexpected statement ${state.executes}`);
      return answer;
    },
    // publishedSingleton: no published purposes, so the gate uses the default (consent) basis.
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

const gate = (id: string, status: string | null, mergedInto: string | null = null, updatedAt = '2026-10-01T00:00:00.000Z') => ({
  rows: [{ origin: id, id, merged_into: mergedInto, status, updated_at: updatedAt }],
});

describe('a preparation discards state built under a changed consent (#1300)', () => {
  it('refuses when the survivor’s consent changed without the id changing', async () => {
    const { tx, state } = fakeTx([gate('prf_one', 'granted'), gate('prf_one', 'objected')]);
    const built: string[] = [];
    const prepared = await prepareForPerson(tx, 'ws_test', 'prf_one', aiAllowed, async (profileId) => {
      built.push(profileId);
      return { value: `state:${profileId}` };
    });
    expect(prepared).toMatchObject({ refusal: expect.stringContaining('no_lawful_basis') });
    // The state was built once and then thrown away; it is not returned under the stale answer.
    expect(built).toEqual(['prf_one']);
    expect(state.executes).toBe(2);
  }, 30_000);

  it('rebuilds for the survivor when the person moved during the build', async () => {
    const { tx, state } = fakeTx([gate('prf_one', 'granted'), gate('prf_two', 'granted'), gate('prf_two', 'granted')]);
    const built: string[] = [];
    const prepared = await prepareForPerson(tx, 'ws_test', 'prf_one', aiAllowed, async (profileId) => {
      built.push(profileId);
      return { value: `state:${profileId}` };
    });
    expect(prepared).toEqual({ profileId: 'prf_two', value: 'state:prf_two' });
    // The build for the merged-away id is discarded, not used for the survivor.
    expect(built).toEqual(['prf_one', 'prf_two']);
    expect(state.executes).toBe(3);
  }, 30_000);

  it('rebuilds when a merge changed the survivor’s revision but not its id', async () => {
    // A profile merging INTO the person keeps the survivor's id. The gate answers the same id and
    // the same consent both times, so the build has to be discarded for the changed revision.
    const { tx, state } = fakeTx([
      gate('prf_one', 'granted', null, '2026-10-01T00:00:00.000Z'),
      gate('prf_one', 'granted', null, '2026-10-01T00:00:05.000Z'),
      gate('prf_one', 'granted', null, '2026-10-01T00:00:05.000Z'),
    ]);
    const built: string[] = [];
    const prepared = await prepareForPerson(tx, 'ws_test', 'prf_one', aiAllowed, async (profileId) => {
      built.push(profileId);
      return { value: `state:${profileId}:${built.length}` };
    });
    expect(prepared).toEqual({ profileId: 'prf_one', value: 'state:prf_one:2' });
    // The first build straddled the merge and was thrown away, not returned.
    expect(built).toEqual(['prf_one', 'prf_one']);
    expect(state.executes).toBe(3);
  }, 30_000);

  it('does not build anything for a person who does not exist', async () => {
    const { tx, state } = fakeTx([{ rows: [] }]);
    const built: string[] = [];
    const prepared = await prepareForPerson(tx, 'ws_test', 'prf_gone', aiAllowed, async (profileId) => {
      built.push(profileId);
      return { value: `state:${profileId}` };
    });
    expect(prepared).toMatchObject({ refusal: expect.stringContaining('no_profile') });
    expect(built).toEqual([]);
    expect(state.executes).toBe(1);
  }, 30_000);
});
