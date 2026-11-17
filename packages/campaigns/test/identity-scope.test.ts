import type { Tx } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { loadIdentityMap } from '../src/identity';

// #986: the campaign identity map must not read the workspace's whole merge list, and it must stop
// as soon as its pair bound is passed instead of loading every identifier of one survivor first.

let d: DisposableDb;

beforeAll(async () => {
  if (hasTestDatabase()) d = await createDisposableDb('identity_scope');
}, 180_000);

afterAll(async () => {
  await d?.close();
});

/**
 * A transaction proxy that counts the rows every query returns. The test asserts the loader reads a
 * handful of rows, which is what the bug was about; the map's contents alone cannot show it because
 * the old code filtered unrelated merges out after reading them all.
 */
function countingTx(tx: Tx): { tx: Tx; rowsRead: () => number } {
  let rows = 0;
  const counted = (value: unknown): unknown => {
    if (Array.isArray(value)) rows += value.length;
    else if (value && typeof value === 'object' && Array.isArray((value as { rows?: unknown[] }).rows))
      rows += (value as { rows: unknown[] }).rows!.length;
    return value;
  };
  const proxied = (target: object): Tx =>
    new Proxy(target, {
      get(t, prop) {
        if (prop === 'then')
          return (onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
            (t as PromiseLike<unknown>).then((value) => (onFulfilled ? onFulfilled(counted(value)) : counted(value)), onRejected);
        const value = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = value.apply(t, args);
          return result && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function'
            ? proxied(result)
            : result;
        };
      },
    }) as Tx;
  return { tx: proxied(tx), rowsRead: () => rows };
}

async function insertProfiles(ids: readonly string[]): Promise<void> {
  await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x`, [d.workspace, ids]);
}

describe.skipIf(!hasTestDatabase())('a bounded campaign identity map (#986)', () => {
  it('reads only the campaign’s merge component, not the workspace’s unrelated merges', async () => {
    // Thousands of merges elsewhere in the workspace, each with an identifier. The old loader read
    // every one of them before filtering; the scoped loader must not touch them.
    const unrelated = 4_000;
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, merged_into)
       SELECT $1, 'prf_unrelated_a_' || g, 'prf_unrelated_b_' || g FROM generate_series(1, $2) AS g`,
      [d.workspace, unrelated],
    );
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id)
       SELECT $1, 'prf_unrelated_b_' || g FROM generate_series(1, $2) AS g`,
      [d.workspace, unrelated],
    );
    await d.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id)
       SELECT $1, 'user_id', 'unrelated-user-' || g, 'prf_unrelated_a_' || g FROM generate_series(1, $2) AS g`,
      [d.workspace, unrelated],
    );

    await insertProfiles(['prf_scoped_alias', 'prf_scoped_survivor']);
    await d.db.admin.query(`UPDATE profiles SET merged_into = 'prf_scoped_survivor' WHERE workspace_id = $1 AND id = 'prf_scoped_alias'`, [
      d.workspace,
    ]);
    await d.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id) VALUES ($1, 'user_id', 'scoped-user', 'prf_scoped_survivor')`,
      [d.workspace],
    );

    const result = await d.db.withWorkspace(d.workspace, async (tx) => {
      const counted = countingTx(tx);
      const map = await loadIdentityMap(counted.tx, d.workspace, { profileIds: ['prf_scoped_survivor'] });
      return { map, rows: counted.rowsRead() };
    });

    expect(result.map.overLimit).toBe(false);
    expect(result.map.pairs.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'prf_scoped_alias', profileId: 'prf_scoped_survivor', kind: 'profile' },
      { key: 'scoped-user', profileId: 'prf_scoped_survivor', kind: 'user_id' },
    ]);
    // Two merge rows, the survivor row and its one identifier, plus the representatives query.
    expect(result.rows).toBeLessThan(20);
  }, 120_000);

  it('stops reading a survivor’s identifiers as soon as the pair bound is passed', async () => {
    const identifiers = 20_000;
    await insertProfiles(['prf_big_survivor']);
    await d.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id)
       SELECT $1, 'user_id', 'big-user-' || g, 'prf_big_survivor' FROM generate_series(1, $2) AS g`,
      [d.workspace, identifiers],
    );

    const result = await d.db.withWorkspace(d.workspace, async (tx) => {
      const counted = countingTx(tx);
      const map = await loadIdentityMap(counted.tx, d.workspace, { profileIds: ['prf_big_survivor'], limit: 25 });
      return { map, rows: counted.rowsRead() };
    });

    expect(result.map).toEqual({ pairs: [], overLimit: true, limit: 25 });
    // The bound is 25, so at most one row past it is read; the 20,000 are never loaded.
    expect(result.rows).toBeLessThan(100);
  }, 120_000);

  it('spends its mapping bound on mappings, not on a survivor with many aliases (#1015)', async () => {
    // A survivor reached through 25 aliases is 26 component rows but 25 mappings; the bound is
    // about mappings, so exactly 25 must resolve and 26 must not.
    const atLimit = Array.from({ length: 25 }, (_, i) => `prf_at_limit_alias_${String(i).padStart(2, '0')}`);
    await insertProfiles(['prf_at_limit_survivor', ...atLimit]);
    await d.db.admin.query(`UPDATE profiles SET merged_into = 'prf_at_limit_survivor' WHERE workspace_id = $1 AND id = ANY($2::text[])`, [
      d.workspace,
      atLimit,
    ]);

    const exact = await d.db.withWorkspace(d.workspace, (tx) =>
      loadIdentityMap(tx, d.workspace, { profileIds: ['prf_at_limit_survivor'], limit: 25 }),
    );
    expect(exact.overLimit).toBe(false);
    expect(exact.limit).toBe(25);
    expect(exact.pairs).toHaveLength(25);
    expect(exact.pairs.every((pair) => pair.profileId === 'prf_at_limit_survivor')).toBe(true);

    const overLimit = Array.from({ length: 26 }, (_, i) => `prf_over_limit_alias_${String(i).padStart(2, '0')}`);
    await insertProfiles(['prf_over_limit_survivor', ...overLimit]);
    await d.db.admin.query(`UPDATE profiles SET merged_into = 'prf_over_limit_survivor' WHERE workspace_id = $1 AND id = ANY($2::text[])`, [
      d.workspace,
      overLimit,
    ]);
    const over = await d.db.withWorkspace(d.workspace, (tx) =>
      loadIdentityMap(tx, d.workspace, { profileIds: ['prf_over_limit_survivor'], limit: 25 }),
    );
    expect(over).toEqual({ pairs: [], overLimit: true, limit: 25 });
  }, 120_000);

  it('stops a corrupt chain at the walk bound instead of following it (#1015)', async () => {
    // The forward walk used to follow every seed's whole chain before anything else was checked.
    const depth = 1_000;
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, merged_into)
       SELECT $1, 'prf_deep_' || lpad(g::text, 4, '0'),
         CASE WHEN g < $2::int THEN 'prf_deep_' || lpad((g + 1)::text, 4, '0') END
       FROM generate_series(1, $2::int + 1) AS g`,
      [d.workspace, depth],
    );

    const result = await d.db.withWorkspace(d.workspace, (tx) =>
      loadIdentityMap(tx, d.workspace, { profileIds: ['prf_deep_0001'], limit: 100_000 }),
    );
    expect(result).toEqual({ pairs: [], overLimit: true, limit: 100_000 });
  }, 120_000);

  it('stops loading identifiers as soon as their bytes pass the bound (#1015)', async () => {
    // Reading every identifier first and checking bytes afterwards held the whole list in memory.
    // One bounded page is read, and the cumulative byte count stops the load inside it.
    const identifiers = 5_000;
    await insertProfiles(['prf_long_ids']);
    await d.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id)
       SELECT $1, 'user_id', 'long-' || g || '-' || repeat('x', 1000), 'prf_long_ids'
       FROM generate_series(1, $2) AS g`,
      [d.workspace, identifiers],
    );

    const result = await d.db.withWorkspace(d.workspace, async (tx) => {
      const counted = countingTx(tx);
      const map = await loadIdentityMap(counted.tx, d.workspace, { profileIds: ['prf_long_ids'], maxBytes: 10_000 });
      return { map, rows: counted.rowsRead() };
    });

    expect(result.map.overLimit).toBe(true);
    expect(result.map.pairs).toEqual([]);
    // The component reads plus one identifier page, not the 5,000 long rows.
    expect(result.rows).toBeLessThan(1_500);
  }, 120_000);
});
