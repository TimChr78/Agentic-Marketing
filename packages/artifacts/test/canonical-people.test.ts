import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { canonicalPeople } from '../src/holdout';

// #944: every holdout read resolves an assignment's profile to the person it belongs to today. The
// walk is one query per frontier, so a large campaign's frontier must not become one query
// parameter per id: PostgreSQL refuses more than 65,535 parameters, and `holdoutResult` would fail
// on a big workspace even with no merges at all.

let d: DisposableDb;

beforeAll(async () => {
  if (hasTestDatabase()) d = await createDisposableDb('canonical_people');
}, 180_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('canonicalPeople (#944)', () => {
  it('resolves a chain of merges to the survivor, and leaves an unknown id to itself', async () => {
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
         ($1, 'prf_chain_a', 'prf_chain_b'), ($1, 'prf_chain_b', 'prf_chain_c'), ($1, 'prf_chain_c', NULL)`,
      [d.workspace],
    );
    const map = await d.db.withWorkspace(d.workspace, (tx) =>
      canonicalPeople(tx, d.workspace, ['prf_chain_a', 'prf_chain_b', 'prf_chain_c', 'prf_unknown']),
    );
    expect(map.get('prf_chain_a')).toBe('prf_chain_c');
    expect(map.get('prf_chain_b')).toBe('prf_chain_c');
    expect(map.get('prf_chain_c')).toBe('prf_chain_c');
    expect(map.get('prf_unknown')).toBe('prf_unknown');
  }, 60_000);

  it('takes more ids than one statement can bind as parameters', async () => {
    const people = 70_000;
    await d.db.admin.query(
      `INSERT INTO profiles (workspace_id, id)
       SELECT $1, 'prf_bulk_' || lpad(i::text, 24, '0') FROM generate_series(1, $2) i`,
      [d.workspace, people],
    );
    const ids = Array.from({ length: people }, (_, i) => `prf_bulk_${String(i + 1).padStart(24, '0')}`);
    const map = await d.db.withWorkspace(d.workspace, (tx) => canonicalPeople(tx, d.workspace, ids));
    expect(map.size).toBe(people);
    expect(map.get(ids[0]!)).toBe(ids[0]);
    expect(map.get(ids.at(-1)!)).toBe(ids.at(-1));
  }, 180_000);
});
