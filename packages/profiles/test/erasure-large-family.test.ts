import { type KeyProvider, localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';
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
  it('records the whole ledger for 10,923 rows, more than one statement can bind', async () => {
    const profile = 'prf_0000000000000000000000000000c101';
    const anon = 'ledger-large-1-';
    const anonymousIds = 5_460;
    await seedPerson(profile, anon, anonymousIds);

    // Profile, user id, and two rows per anonymous id: 1 + 2 + 2 × 5,460 ledger rows, six
    // parameters each, so 65,538 bound parameters.
    const result = await erase(profile);
    expect(result).toMatchObject({ status: 'pending', counts: { profiles: 1, identifiers: anonymousIds + 1 } });
    expect(await ledgerCount(result.erasureId)).toBe(1 + 2 + 2 * anonymousIds);

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
  }, 120_000);

  it('records every tombstone for 21,847 identifiers, more than one statement can bind', async () => {
    const profile = 'prf_0000000000000000000000000000c102';
    const anon = 'tombstone-large-2-';
    const anonymousIds = 21_846;
    await seedPerson(profile, anon, anonymousIds);

    // One tombstone per identifier at three bound parameters each: 21,847 × 3 = 65,541, past the
    // limit as well; the ledger for the same family is 43,695 rows.
    const result = await erase(profile);
    expect(result).toMatchObject({ status: 'pending', counts: { profiles: 1, identifiers: anonymousIds + 1 } });
    expect(await tombstoneCount(result.erasureId)).toBe(anonymousIds + 1);
    expect(await ledgerCount(result.erasureId)).toBe(1 + 2 + 2 * anonymousIds);

    const hasher = await subjectKeyHasher({ db: d.db, kp: keyProvider })(d.workspace);
    const probed = [await hasher.hash('anonymous_id', `${anon}1`), await hasher.hash('anonymous_id', `${anon}${anonymousIds}`)];
    hasher.dispose();
    const { rows } = await d.db.admin.query<{ key_value: string; coverage: string }>(
      'SELECT key_value, coverage FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2 AND kind = $3 AND key_value = ANY($4::text[])',
      [d.workspace, result.erasureId, 'anonymous_id', probed],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.coverage).toBe('full');
  }, 120_000);

  it("erases a family whose anonymous-id list exceeds one statement's parameters", async () => {
    const profile = 'prf_0000000000000000000000000000c103';
    const anon = 'bind-limit-';
    // One bound parameter per anonymous id in the push-subscription delete put this list over
    // PostgreSQL's 65,535-parameter limit; the statement failed, the stage rolled back, and the
    // person could never be erased. No push subscription row exists: the statement still binds the
    // whole list.
    const anonymousIds = 65_600;
    await seedPerson(profile, anon, anonymousIds);

    const result = await erase(profile);
    expect(result).toMatchObject({ status: 'pending', counts: { profiles: 1, identifiers: anonymousIds + 1 } });
    expect(await ledgerCount(result.erasureId)).toBe(1 + 2 + 2 * anonymousIds);
    const { rows } = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [d.workspace, profile]);
    expect(rows).toHaveLength(0);
  }, 240_000);
});
