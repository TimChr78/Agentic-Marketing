import { randomUUID } from 'node:crypto';
import { type KeyProvider, localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { personCrypto } from '../src/crypto';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';
import { subjectKeyHasher } from '../src/exclusion';

// #1037 part 1: the erasure-key ledger is HMAC_exclusion of every identifier under a dedicated,
// workspace-scoped exclusion key, written in the erasure's SQL stage transaction. No raw
// identifier is kept; the ledger survives a matching-key rotation because it never uses that key.

const MASTER_KEY = Buffer.alloc(32, 61).toString('base64');
const EMAIL = 'ledger-person@example.test';
const PHONE = '+15550100200';
/** A user id may be an e-mail address in practice: the ledger must never keep it raw. */
const EMAIL_USER_ID = 'user-as-address@example.test';
const ANON = 'anon-ledger-1';
const GCLID = 'gclid-ledger-1234';

type Disposable = Awaited<ReturnType<typeof createDisposableDb>>;

let d: Disposable;
let keyProvider: KeyProvider;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('erasure_ledger');
  keyProvider = localKeyProvider(MASTER_KEY);
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function newWorkspace(): Promise<string> {
  const workspace = randomUUID();
  await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Ledger', 'none')", [workspace]);
  return workspace;
}

async function activeKeyId(workspace: string, purpose: 'matching' | 'exclusion'): Promise<string> {
  const { rows } = await d.db.admin.query<{ id: string }>('SELECT id FROM data_keys WHERE workspace_id = $1 AND purpose = $2 AND active', [
    workspace,
    purpose,
  ]);
  return rows[0]!.id;
}

async function seedPerson(workspace: string, profileId: string, mergedFrom: string[] = []): Promise<void> {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [workspace, profileId]);
  for (const merged of mergedFrom) {
    await d.db.admin.query('INSERT INTO profiles (workspace_id, id, merged_into) VALUES ($1, $2, $3)', [workspace, merged, profileId]);
    await d.db.admin.query("INSERT INTO profile_merges (workspace_id, from_id, into_id, reason) VALUES ($1, $2, $3, 'ledger test')", [
      workspace,
      merged,
      profileId,
    ]);
    await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      workspace,
      merged,
      'anonymous_id',
      `${merged}-anon`,
    ]);
  }
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    workspace,
    profileId,
    'user_id',
    EMAIL_USER_ID,
  ]);
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    workspace,
    profileId,
    'anonymous_id',
    ANON,
  ]);
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    workspace,
    profileId,
    'gclid',
    GCLID,
  ]);
}

async function sealAndStoreIdentifier(workspace: string, profileId: string, type: 'email' | 'phone', plain: string): Promise<void> {
  // The identifier's lookup value is a matching-key HMAC; the sealed plaintext is what the ledger
  // hashes with the exclusion key, exactly as a stored row hashes the raw trait at write time.
  const { value, sealed } = await d.db.withWorkspace(workspace, async (tx) => {
    const crypto = personCrypto(tx, workspace, keyProvider);
    return {
      value: await crypto.matchHash(type, plain),
      sealed: await crypto.seal(profileId, plain),
    };
  });
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value, value_enc) VALUES ($1, $2, $3, $4, $5)', [
    workspace,
    profileId,
    type,
    value,
    sealed,
  ]);
}

/** A legacy e-mail identifier: its lookup HMAC exists, its sealed plaintext does not. */
async function storeMatchOnlyIdentifier(workspace: string, profileId: string, type: 'email' | 'phone', plain: string): Promise<string> {
  const value = await d.db.withWorkspace(workspace, (tx) => personCrypto(tx, workspace, keyProvider).matchHash(type, plain));
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    workspace,
    profileId,
    type,
    value,
  ]);
  return value;
}

async function ledger(workspace: string, erasureId: string) {
  const { rows } = await d.db.admin.query<{ kind: string; key_value: string; key_version: string; erasure_id: string; coverage: string }>(
    'SELECT kind, key_value, key_version, erasure_id, coverage FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2 ORDER BY kind, key_value',
    [workspace, erasureId],
  );
  return rows;
}

describe.skipIf(!hasTestDatabase())('erasure-key ledger (#1037 part 1)', () => {
  it('stores only keyed hashes for the whole family, traits, click ids and previous ids', async () => {
    const workspace = await newWorkspace();
    const survivor = 'prf_00000000000000000000000000000101';
    const merged = 'prf_00000000000000000000000000000102';
    await seedPerson(workspace, survivor, [merged]);
    await sealAndStoreIdentifier(workspace, survivor, 'email', EMAIL);
    await sealAndStoreIdentifier(workspace, survivor, 'phone', PHONE);
    const expected = await subjectKeyHasher({ db: d.db, kp: keyProvider })(workspace);
    const expectedEmail = await expected.hash('email', EMAIL);
    const expectedPhone = await expected.hash('phone', PHONE);
    const expectedUser = await expected.hash('user_id', EMAIL_USER_ID);
    const expectedAnon = await expected.hash('anonymous_id', ANON);
    const expectedPrevious = await expected.hash('alias_previous_id', ANON);
    const expectedClick = await expected.hash('gclid', GCLID);
    const expectedProfile = await expected.hash('profile', survivor);
    const expectedMerged = await expected.hash('profile', merged);
    const expectedMergedAnon = await expected.hash('anonymous_id', `${merged}-anon`);
    const version = expected.version;
    expected.dispose();

    const prepared = await prepareErasure(d.db, workspace, keyProvider);
    try {
      const result = await d.db.withWorkspace(workspace, (tx) =>
        eraseProfileStage(tx, { workspaceId: workspace, profileId: merged, requestedBy: 'user_ledger', reason: 'ledger test', prepared }),
      );
      const rows = await ledger(workspace, result.erasureId);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'profile', key_value: expectedProfile, key_version: version, coverage: 'full' }),
          expect.objectContaining({ kind: 'profile', key_value: expectedMerged, key_version: version }),
          expect.objectContaining({ kind: 'anonymous_id', key_value: expectedMergedAnon, key_version: version }),
          expect.objectContaining({ kind: 'anonymous_id', key_value: expectedAnon, key_version: version, coverage: 'full' }),
          expect.objectContaining({ kind: 'user_id', key_value: expectedUser, key_version: version }),
          expect.objectContaining({ kind: 'alias_previous_id', key_value: expectedPrevious, key_version: version }),
          expect.objectContaining({ kind: 'email', key_value: expectedEmail, key_version: version, coverage: 'full' }),
          expect.objectContaining({ kind: 'phone', key_value: expectedPhone, key_version: version, coverage: 'full' }),
          expect.objectContaining({ kind: 'gclid', key_value: expectedClick, key_version: version, coverage: 'full' }),
        ]),
      );
      // Every row is a 64-character keyed hash, never a raw identifier.
      for (const row of rows) expect(row.key_value).toMatch(/^[0-9a-f]{64}$/);
      const raw = JSON.stringify(rows);
      for (const plain of [EMAIL, PHONE.replace('+', ''), EMAIL_USER_ID, ANON, GCLID, merged, survivor]) expect(raw).not.toContain(plain);
    } finally {
      disposeErasure(prepared);
    }
  });

  it('leaves no ledger row when the SQL stage rolls back', async () => {
    const workspace = await newWorkspace();
    const profile = 'prf_00000000000000000000000000000201';
    await seedPerson(workspace, profile);
    const prepared = await prepareErasure(d.db, workspace, keyProvider);
    try {
      await expect(
        d.db.withWorkspace(workspace, async (tx) => {
          await eraseProfileStage(tx, {
            workspaceId: workspace,
            profileId: profile,
            requestedBy: 'user_ledger',
            reason: 'rollback test',
            prepared,
          });
          throw new Error('rollback after the stage');
        }),
      ).rejects.toThrow('rollback after the stage');
      const keys = await d.db.admin.query('SELECT 1 FROM erasure_keys WHERE workspace_id = $1', [workspace]);
      expect(keys.rowCount).toBe(0);
      const erasures = await d.db.admin.query('SELECT 1 FROM erasures WHERE workspace_id = $1', [workspace]);
      expect(erasures.rowCount).toBe(0);
    } finally {
      disposeErasure(prepared);
    }
  });

  it('keeps the same exclusion hashes when the matching key rotates', async () => {
    const workspace = await newWorkspace();
    const profile = 'prf_00000000000000000000000000000301';
    await seedPerson(workspace, profile);
    await sealAndStoreIdentifier(workspace, profile, 'email', EMAIL);

    // These are the hashes a stored row would keep, written while matching key K1 is active.
    const before = await subjectKeyHasher({ db: d.db, kp: keyProvider })(workspace);
    const beforeEmail = await before.hash('email', EMAIL);
    const beforeUser = await before.hash('user_id', EMAIL_USER_ID);
    const beforeVersion = before.version;
    before.dispose();
    const matchingBefore = await activeKeyId(workspace, 'matching');

    // Rotate the matching key. A new row written now would use K2 for matching; the exclusion key
    // and its hashes must not change.
    await d.db.admin.query("UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = 'matching'", [workspace]);

    const prepared = await prepareErasure(d.db, workspace, keyProvider);
    try {
      const result = await d.db.withWorkspace(workspace, (tx) =>
        eraseProfileStage(tx, { workspaceId: workspace, profileId: profile, requestedBy: 'user_ledger', reason: 'rotation', prepared }),
      );
      const matchingAfter = await activeKeyId(workspace, 'matching');
      expect(matchingAfter).not.toBe(matchingBefore);
      expect(await activeKeyId(workspace, 'exclusion')).toBe(beforeVersion);
      const rows = await ledger(workspace, result.erasureId);
      expect(rows.find((r) => r.kind === 'email')).toMatchObject({ key_value: beforeEmail, key_version: beforeVersion });
      expect(rows.find((r) => r.kind === 'user_id')).toMatchObject({ key_value: beforeUser, key_version: beforeVersion });
    } finally {
      disposeErasure(prepared);
    }
  });

  it('records unavailable coverage instead of hashing a matching-key value', async () => {
    const workspace = await newWorkspace();
    const profile = 'prf_00000000000000000000000000000401';
    await seedPerson(workspace, profile);
    const matchOnly = await storeMatchOnlyIdentifier(workspace, profile, 'email', EMAIL);

    const prepared = await prepareErasure(d.db, workspace, keyProvider);
    try {
      const result = await d.db.withWorkspace(workspace, (tx) =>
        eraseProfileStage(tx, { workspaceId: workspace, profileId: profile, requestedBy: 'user_ledger', reason: 'legacy', prepared }),
      );
      const rows = await ledger(workspace, result.erasureId);
      const email = rows.find((r) => r.kind === 'email');
      // The stored matching-key HMAC is kept as an explanatory placeholder, but marked
      // unavailable; nothing pretends it can match a write-time exclusion hash.
      expect(email).toMatchObject({ key_value: matchOnly, coverage: 'unavailable' });
      expect(JSON.stringify(rows)).not.toContain(EMAIL);
    } finally {
      disposeErasure(prepared);
    }
  });

  it('activates the exclusion key the ledger references and refuses a missing one', async () => {
    const workspace = await newWorkspace();
    const keyId = 'dk_0000000000000000000000000000ee01';
    const wrapped = await keyProvider.wrap(Buffer.alloc(32, 5));
    await d.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, active, purpose)
       VALUES ($1, $2, $3, $4, false, 'exclusion')`,
      [workspace, keyId, keyProvider.id, wrapped],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id)
       VALUES ($1, 'profile', $2, $3, 'era_keeps_key')`,
      [workspace, 'a'.repeat(64), keyId],
    );
    const hasher = await subjectKeyHasher({ db: d.db, kp: keyProvider })(workspace);
    expect(hasher.version).toBe(keyId);
    hasher.dispose();
    const active = await d.db.admin.query<{ id: string }>(
      "SELECT id FROM data_keys WHERE workspace_id = $1 AND purpose = 'exclusion' AND active",
      [workspace],
    );
    expect(active.rows).toEqual([{ id: keyId }]);

    // A ledger row whose key was lost must not make the next call mint a different key: its
    // hashes could never match, so the call refuses.
    const orphan = await newWorkspace();
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id)
       VALUES ($1, 'profile', $2, 'dk_lost', 'era_lost')`,
      [orphan, 'b'.repeat(64)],
    );
    await expect(subjectKeyHasher({ db: d.db, kp: keyProvider })(orphan)).rejects.toThrow(/exclusion key referenced .* is missing/);
  });

  it('hashes with the workspace exclusion key and never swallows a key failure', async () => {
    const workspace = await newWorkspace();
    const factory = subjectKeyHasher({ db: d.db, kp: keyProvider });
    const hasher = await factory(workspace);
    expect(hasher.version).toBe(await activeKeyId(workspace, 'exclusion'));
    const first = await hasher.hash('profile', 'prf_hash_test');
    expect(await hasher.hash('profile', 'prf_hash_test')).toBe(first);
    expect(await hasher.hash('profile', 'prf_other')).not.toBe(first);
    expect(await hasher.hash('email', 'A@Example.test')).toBe(await hasher.hash('email', 'a@example.test'));
    hasher.dispose();
    const broken: KeyProvider = {
      id: 'broken',
      async unwrap() {
        throw new Error('exclusion key unavailable');
      },
      async wrap() {
        throw new Error('exclusion key unavailable');
      },
    };
    await expect(subjectKeyHasher({ db: d.db, kp: broken })(workspace)).rejects.toThrow('exclusion key unavailable');
  });
});
