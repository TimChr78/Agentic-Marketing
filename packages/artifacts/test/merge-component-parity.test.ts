import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { assignHoldout, canonicalPeople, type HoldoutScope, holdoutHashVersion, holdoutWinners } from '../src/holdout';

// #985: the send path and the holdout report must resolve a person's merge component the same way.
// They used to disagree past the forward walk's 20-hop bound and on a cycle: the report counted two
// people while the send held one of them out through an assignment the report grouped elsewhere.

const HASH = holdoutHashVersion(50);
const EARLY = new Date('2026-11-01T00:00:00.000Z');
const LATE = new Date('2026-11-02T00:00:00.000Z');

let d: DisposableDb;

beforeAll(async () => {
  if (hasTestDatabase()) d = await createDisposableDb('merge_component_parity');
}, 180_000);

afterAll(async () => {
  await d?.close();
});

let scopes = 0;
const scope = (): HoldoutScope => ({ type: 'campaign', id: `cmp_${String(++scopes).padStart(32, '0')}` });

async function insertProfiles(ids: readonly string[], mergedInto: ReadonlyMap<string, string>): Promise<void> {
  await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x`, [d.workspace, ids]);
  if (mergedInto.size)
    await d.db.admin.query(
      `UPDATE profiles p SET merged_into = x.next
       FROM unnest($2::text[], $3::text[]) AS x(id, next)
       WHERE p.workspace_id = $1 AND p.id = x.id`,
      [d.workspace, [...mergedInto.keys()], [...mergedInto.values()]],
    );
}

/** A chain p0 → p1 → … → pN (N hops), each id lexically after the one before it. */
async function insertChain(prefix: string, hops: number): Promise<string[]> {
  const ids = Array.from({ length: hops + 1 }, (_, i) => `prf_${prefix}_${String(i).padStart(3, '0')}`);
  await insertProfiles(ids, new Map(ids.slice(0, -1).map((id, i) => [id, ids[i + 1]!])));
  return ids;
}

async function assign(target: HoldoutScope, profileId: string, arm: 'control' | 'treatment', at: Date): Promise<void> {
  await d.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [d.workspace, target.type, target.id, HASH, profileId, arm, at],
  );
}

/** The person both paths must agree on: the representative, and the arm the send reads back. */
async function expectOnePerson(ids: readonly string[], representative: string) {
  const target = scope();
  await assign(target, ids[0]!, 'control', EARLY);
  await assign(target, ids.at(-1)!, 'treatment', LATE);

  await d.db.withWorkspace(d.workspace, async (tx) => {
    const canonical = await canonicalPeople(tx, d.workspace, ids);
    for (const id of ids) expect(canonical.get(id)).toBe(representative);

    // The report groups the two ends into one person and keeps the earliest assignment.
    const winners = await holdoutWinners(tx, d.workspace, target, HASH);
    expect([winners.control, winners.treatment]).toEqual([1, 0]);
    expect(await winners.page(undefined, 10)).toEqual([{ person: representative, arm: 'control', assignedAt: EARLY }]);

    // The send path reads the same person: from the treatment end, from the control end, and from
    // every profile in between, the decision is the control assignment the report kept.
    for (const id of [ids.at(-1)!, ids[0]!, ...ids.slice(1, -1)]) {
      const stored = await assignHoldout(tx, d.workspace, target, { percent: 50 }, id);
      expect(stored?.assignment.arm).toBe('control');
    }
  });
}

describe.skipIf(!hasTestDatabase())('one merge component for the send and the report (#985)', () => {
  for (const hops of [19, 20, 21, 22]) {
    it(`agrees on a chain of ${hops} hops`, async () => {
      const ids = await insertChain(`h${hops}`, hops);
      // The end of the chain is the person; the walk is not truncated by a hop bound.
      await expectOnePerson(ids, ids.at(-1)!);
    }, 60_000);
  }

  it('agrees beyond the walk bound, where the person splits at the bound', async () => {
    // A chain longer than MERGE_MAX_HOPS (256) is corruption, but both paths must still resolve
    // each profile the same way: control at the far end and treatment at the near end belong to
    // different groups, and each send reads the arm its own group has in the report.
    const hops = 300;
    const ids = await insertChain('beyond', hops);
    const target = scope();
    await assign(target, ids[0]!, 'control', EARLY);
    await assign(target, ids.at(-1)!, 'treatment', LATE);

    await d.db.withWorkspace(d.workspace, async (tx) => {
      const winners = await holdoutWinners(tx, d.workspace, target, HASH);
      expect([winners.control, winners.treatment]).toEqual([1, 1]);
      const page = await winners.page(undefined, 10);

      // The far end resolves to the node where the bound stopped it; the near end is a terminal.
      const canonical = await canonicalPeople(tx, d.workspace, ids);
      expect(canonical.get(ids[0]!)).toBe(ids[256]);
      expect(canonical.get(ids.at(-1)!)).toBe(ids.at(-1));

      // Each send reads the arm its own report group has, before the send re-records anything.
      const armOf = (id: string) => page.find((winner) => winner.person === canonical.get(id))?.arm;
      const nearEnd = ids.at(-1)!;
      expect((await assignHoldout(tx, d.workspace, target, { percent: 50 }, nearEnd))?.assignment.arm).toBe(armOf(nearEnd));
      expect(armOf(nearEnd)).toBe('treatment');
      const farEnd = ids[0]!;
      expect((await assignHoldout(tx, d.workspace, target, { percent: 50 }, farEnd))?.assignment.arm).toBe(armOf(farEnd));
      expect(armOf(farEnd)).toBe('control');
    });
  }, 60_000);

  it('agrees on a cycle', async () => {
    // prf_cycle_a is lexically lowest, so it is the representative of the cycle.
    await insertProfiles(
      ['prf_cycle_a', 'prf_cycle_b'],
      new Map([
        ['prf_cycle_a', 'prf_cycle_b'],
        ['prf_cycle_b', 'prf_cycle_a'],
      ]),
    );
    await expectOnePerson(['prf_cycle_a', 'prf_cycle_b'], 'prf_cycle_a');
  }, 60_000);

  it('agrees on a cycle plus a tail', async () => {
    // The tail id sorts below both cycle ids, so a component-minimum rule would give the wrong
    // representative: the cycle's own lowest id is the person, and the tail belongs to them.
    await insertProfiles(
      ['prf_tailcycle_0', 'prf_tailcycle_a', 'prf_tailcycle_b'],
      new Map([
        ['prf_tailcycle_0', 'prf_tailcycle_a'],
        ['prf_tailcycle_a', 'prf_tailcycle_b'],
        ['prf_tailcycle_b', 'prf_tailcycle_a'],
      ]),
    );
    await expectOnePerson(['prf_tailcycle_0', 'prf_tailcycle_a', 'prf_tailcycle_b'], 'prf_tailcycle_a');
  }, 60_000);
});
