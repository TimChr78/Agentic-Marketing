import { type KeyProvider, localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { normalizeEmail, personCrypto } from '../src/crypto';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';

// #1037 part 1: the erasure-key ledger is written in the erasure's SQL stage transaction, one
// pseudonymous key per identifier, and nothing prunes it. The values are the same ids stored rows
// carry, or the matching key's HMAC for e-mail/phone; no plaintext address is ever kept.

const MASTER_KEY = Buffer.alloc(32, 61).toString('base64');
const EMAIL = 'ledger-person@example.test';
const PHONE = '+15550100200';

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
  const { randomUUID } = await import('node:crypto');
  const workspace = randomUUID();
  await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Ledger', 'none')", [workspace]);
  return workspace;
}

async function matchingKeyId(workspace: string): Promise<string> {
  const { rows } = await d.db.admin.query<{ id: string }>(
    "SELECT id FROM data_keys WHERE workspace_id = $1 AND purpose = 'matching' AND active",
    [workspace],
  );
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
    `${profileId}-user`,
  ]);
}

async function ledger(workspace: string, erasureId: string) {
  const { rows } = await d.db.admin.query<{
    kind: string;
    key_value: string;
    key_version: string;
    erasure_id: string;
  }>(
    'SELECT kind, key_value, key_version, erasure_id FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2 ORDER BY kind, key_value',
    [workspace, erasureId],
  );
  return rows;
}

describe.skipIf(!hasTestDatabase())('erasure-key ledger (#1037 part 1)', () => {
  it('writes the whole family and its keyed identifiers in the erasure transaction', async () => {
    const workspace = await newWorkspace();
    const survivor = 'prf_00000000000000000000000000000101';
    const merged = 'prf_00000000000000000000000000000102';
    await seedPerson(workspace, survivor, [merged]);

    const prepared = await prepareErasure(d.db, workspace, keyProvider);
    try {
      // Identifiers store the matching key's HMAC for e-mail and phone, never the address.
      const { emailHash, phoneHash } = await d.db.withWorkspace(workspace, async (tx) => {
        const crypto = personCrypto(tx, workspace, prepared.matching.provider);
        return {
          emailHash: await crypto.matchHash('email', EMAIL),
          phoneHash: await crypto.matchHash('phone', PHONE),
        };
      });
      await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
        workspace,
        survivor,
        'email',
        emailHash,
      ]);
      await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
        workspace,
        survivor,
        'phone',
        phoneHash,
      ]);
      const version = await matchingKeyId(workspace);

      const result = await d.db.withWorkspace(workspace, (tx) =>
        eraseProfileStage(tx, { workspaceId: workspace, profileId: merged, requestedBy: 'user_ledger', reason: 'ledger test', prepared }),
      );

      const rows = await ledger(workspace, result.erasureId);
      expect(rows).toEqual(
        expect.arrayContaining([
          { kind: 'profile', key_value: survivor, key_version: '', erasure_id: result.erasureId },
          { kind: 'profile', key_value: merged, key_version: '', erasure_id: result.erasureId },
          { kind: 'anonymous_id', key_value: `${merged}-anon`, key_version: '', erasure_id: result.erasureId },
          { kind: 'user_id', key_value: `${survivor}-user`, key_version: '', erasure_id: result.erasureId },
          { kind: 'email', key_value: emailHash, key_version: version, erasure_id: result.erasureId },
          { kind: 'phone', key_value: phoneHash, key_version: version, erasure_id: result.erasureId },
        ]),
      );
      // The ledger is independent of the short-lived tombstones: both exist.
      const tombstones = await d.db.admin.query('SELECT 1 FROM erasure_tombstones WHERE workspace_id = $1', [workspace]);
      expect(tombstones.rowCount).toBeGreaterThan(0);
      // No plaintext identifier anywhere in a raw row.
      const raw = await d.db.admin.query<Record<string, unknown>>('SELECT * FROM erasure_keys WHERE workspace_id = $1', [workspace]);
      const serialised = JSON.stringify(raw.rows);
      expect(serialised).not.toContain(normalizeEmail(EMAIL));
      expect(serialised).not.toContain(EMAIL);
      expect(serialised).not.toContain(PHONE.replace('+', ''));
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
      const tombstones = await d.db.admin.query('SELECT 1 FROM erasure_tombstones WHERE workspace_id = $1', [workspace]);
      expect(tombstones.rowCount).toBe(0);
    } finally {
      disposeErasure(prepared);
    }
  });

  it('records the matching key version, and a rotated key gets its own version', async () => {
    const workspace = await newWorkspace();
    const firstName = 'prf_00000000000000000000000000000301';
    const secondName = 'prf_00000000000000000000000000000302';

    const eraseWithEmail = async (workspace: string, profile: string, email: string) => {
      await seedPerson(workspace, profile);
      const prepared = await prepareErasure(d.db, workspace, keyProvider);
      try {
        const hash = await d.db.withWorkspace(workspace, (tx) =>
          personCrypto(tx, workspace, prepared.matching.provider).matchHash('email', email),
        );
        await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
          workspace,
          profile,
          'email',
          hash,
        ]);
        const version = await matchingKeyId(workspace);
        const result = await d.db.withWorkspace(workspace, (tx) =>
          eraseProfileStage(tx, { workspaceId: workspace, profileId: profile, requestedBy: 'user_ledger', reason: 'rotation', prepared }),
        );
        return { version, hash, erasureId: result.erasureId };
      } finally {
        disposeErasure(prepared);
      }
    };

    const before = await eraseWithEmail(workspace, firstName, 'before-rotation@example.test');
    // Rotate the workspace's matching key: deactivate the old one and let the next erase provision
    // a new one. Identifiers hashed with the old key stay interpretable through `key_version`.
    await d.db.admin.query("UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = 'matching'", [workspace]);
    const after = await eraseWithEmail(workspace, secondName, 'after-rotation@example.test');

    expect(before.version).not.toBe(after.version);
    const beforeRows = await ledger(workspace, before.erasureId);
    const afterRows = await ledger(workspace, after.erasureId);
    expect(beforeRows.find((r) => r.kind === 'email')).toMatchObject({ key_value: before.hash, key_version: before.version });
    expect(afterRows.find((r) => r.kind === 'email')).toMatchObject({ key_value: after.hash, key_version: after.version });
    // A raw-id row is not tied to the hashing key.
    expect(beforeRows.find((r) => r.kind === 'profile')).toMatchObject({ key_version: '' });
  });
});
