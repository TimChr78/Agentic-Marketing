import { type KeyProvider, localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { disposeErasure, eraseProfileStage, prepareErasure, removeProfiles } from '../src/erasure';
import { subjectKeyHasher } from '../src/exclusion';

// A profile's identifier list has no bound: resolve() attaches every unknown identifier an event
// carries, so one person can accumulate tens of thousands of them. The erasure writes a tombstone
// per identifier (three bound parameters each) and a ledger row per identifier value (six each, and
// an anonymous or user id contributes two: its own kind and `alias_previous_id`). Batching those
// inserts keeps a large family under PostgreSQL's 65,535-parameter limit, which one statement
// cannot exceed — and an erasure that fails that limit fails on every retry, so the person can
// never be erased.

const MASTER_KEY = Buffer.alloc(32, 62).toString('base64');
/** A user id may be an e-mail address in practice; the ledger must hash it all the same. */
const USER = 'user-as-address@example.test';

type Disposable = Awaited<ReturnType<typeof createDisposableDb>>;

let d: Disposable;
let keyProvider: KeyProvider;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('erasure_large_family');
  keyProvider = localKeyProvider(MASTER_KEY);
}, 120_000);

afterAll(async () => {
  await d?.close();
});

/** One user id and `anonymousIds` anonymous ids, as repeated visits from fresh browsers leave them. */
async function seedPerson(profileId: string, prefix: string, anonymousIds: number): Promise<void> {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [d.workspace, profileId]);
  await d.db.admin.query("INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, 'user_id', $3)", [
    d.workspace,
    profileId,
    `${prefix}-${USER}`,
  ]);
  await d.db.admin.query(
    `INSERT INTO identifiers (workspace_id, profile_id, type, value)
     SELECT $1, $2, 'anonymous_id', $3 || g FROM generate_series(1, $4::int) AS g`,
    [d.workspace, profileId, prefix, anonymousIds],
  );
}

async function erase(profileId: string) {
  const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
  try {
    return await d.db.withWorkspace(d.workspace, (tx) =>
      eraseProfileStage(tx, { workspaceId: d.workspace, profileId, requestedBy: 'user_large_family', reason: 'batch test', prepared }),
    );
  } finally {
    disposeErasure(prepared);
  }
}

async function ledgerCount(erasureId: string): Promise<number> {
  const { rows } = await d.db.admin.query<{ n: string }>(
    'SELECT count(*) AS n FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2',
    [d.workspace, erasureId],
  );
  return Number(rows[0]!.n);
}

async function tombstoneCount(erasureId: string): Promise<number> {
  const { rows } = await d.db.admin.query<{ n: string }>(
    'SELECT count(*) AS n FROM erasure_tombstones WHERE workspace_id = $1 AND erasure_id = $2',
    [d.workspace, erasureId],
  );
  return Number(rows[0]!.n);
}

describe.skipIf(!hasTestDatabase())('erasure of a profile with a large identifier family', () => {
  it('records the whole ledger and every tombstone across several insert batches', async () => {
    const profile = 'prf_0000000000000000000000000000c103';
    const anon = 'bind-limit-';
    // Both original insert limits are crossed by this one family: the ledger gets 1 + 2 + 2 × 21,846
    // rows, past PostgreSQL's 65,535-parameter wall at 10,922 ledger rows, and the tombstones get
    // 21,847 rows, past the same wall at 21,845 identifiers. Each was a deterministic 08P01 on every
    // erasure attempt until the writes were batched. The separate test below pins the largest
    // identifier list the stage binds at once.
    const anonymousIds = 21_846;
    await seedPerson(profile, anon, anonymousIds);

    const result = await erase(profile);
    expect(result).toMatchObject({ status: 'pending', counts: { profiles: 1, identifiers: anonymousIds + 1 } });
    expect(await ledgerCount(result.erasureId)).toBe(1 + 2 + 2 * anonymousIds);
    expect(await tombstoneCount(result.erasureId)).toBe(anonymousIds + 1);

    const hasher = await subjectKeyHasher({ db: d.db, kp: keyProvider })(d.workspace);
    const firstAnon = await hasher.hash('anonymous_id', `${anon}1`);
    const lastAnon = await hasher.hash('anonymous_id', `${anon}${anonymousIds}`);
    const aliasLast = await hasher.hash('alias_previous_id', `${anon}${anonymousIds}`);
    const userId = await hasher.hash('user_id', `${anon}-${USER}`);
    const profileKey = await hasher.hash('profile', profile);
    hasher.dispose();
    const { rows } = await d.db.admin.query<{ kind: string; key_value: string; coverage: string }>(
      `SELECT kind, key_value, coverage FROM erasure_keys
       WHERE workspace_id = $1 AND erasure_id = $2 AND key_value = ANY($3::text[]) ORDER BY kind, key_value`,
      [d.workspace, result.erasureId, [firstAnon, lastAnon, aliasLast, userId, profileKey]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'anonymous_id', key_value: firstAnon, coverage: 'full' }),
        expect.objectContaining({ kind: 'anonymous_id', key_value: lastAnon, coverage: 'full' }),
        expect.objectContaining({ kind: 'alias_previous_id', key_value: aliasLast, coverage: 'full' }),
        expect.objectContaining({ kind: 'user_id', key_value: userId, coverage: 'full' }),
        expect.objectContaining({ kind: 'profile', key_value: profileKey, coverage: 'full' }),
      ]),
    );
    // The stage committed: the profile row and its identifiers are gone.
    const { rows: remaining } = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [
      d.workspace,
      profile,
    ]);
    expect(remaining).toHaveLength(0);
  }, 120_000);

  it('removes a profile whose identifier list is larger than the bound-parameter limit', async () => {
    // The largest list the stage binds at once: the push-subscription delete once bound one
    // parameter per identifier, so a family past PostgreSQL's 65,535-parameter limit failed the
    // stage and the person could never be erased. It now travels as one `text[]`. No row is seeded:
    // the statement still binds the whole list.
    const total = 65_600;
    const profile = 'prf_0000000000000000000000000000c104';
    const identifiers = Array.from({ length: total }, (_, i) => ({
      workspaceId: d.workspace,
      profileId: profile,
      type: 'anonymous_id' as const,
      value: `largest-${i}`,
    }));
    const removed = await d.db.withWorkspace(d.workspace, (tx) =>
      removeProfiles(tx, d.workspace, [profile], identifiers as unknown as Parameters<typeof removeProfiles>[3], { suppress: false }),
    );
    expect(removed.anonymousIds).toHaveLength(total);
    expect(removed).toMatchObject({ profiles: 1, identifiers: total });
  }, 60_000);
});
