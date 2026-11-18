import { afterAll, describe, expect, it } from 'vitest';
import { readErasureLog, replayErasures } from '../src/erasures';
import { createDisposableDb, hasTestDatabase } from './disposable';

// #1037 part 1: a restore must carry the durable erasure-key ledger and the wrapped exclusion keys
// the ledger references. Without the key, a snapshot from before first use would lazily create a
// different key and no ledger value could ever match.

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
afterAll(async () => {
  for (const d of open) await d.close().catch(() => {});
});

const KEY_ID = 'dk_0000000000000000000000000000ee02';
const OLD_KEY_ID = 'dk_0000000000000000000000000000ee01';
const WRAPPED = Buffer.from('wrapped-exclusion-key-bytes');

describe.skipIf(!hasTestDatabase())('restore recreates the erasure-key ledger (#1037)', () => {
  it('reads every key of an erasure and replays it idempotently', async () => {
    const live = await createDisposableDb('erasure_keys_live');
    const restored = await createDisposableDb('erasure_keys_restored');
    open.push(live, restored);
    const workspace = live.workspace;
    const erasureId = 'era_0000000000000000000000000000ee01';
    const recordedAt = new Date('2026-11-01T10:00:00.000Z');
    await live.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, active, purpose)
       VALUES ($1, $2, 'kek_test', $3, true, 'exclusion')`,
      [workspace, KEY_ID, WRAPPED],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, recorded_at, coverage) VALUES
         ($1, 'profile', 'prf_0000000000000000000000000000e001', $2, $3, $4, 'full'),
         ($1, 'anonymous_id', 'anon-ee01', $2, $3, $4, 'full'),
         ($1, 'user_id', 'user-ee01', $2, $3, $4, 'full'),
         ($1, 'email', 'hash-ee01', $2, $3, $4, 'full'),
         ($1, 'phone', 'hash-ee02', $2, $3, $4, 'unavailable')`,
      [workspace, KEY_ID, erasureId, recordedAt],
    );

    const log = await readErasureLog(live.url.toString());
    expect(log.keys).toHaveLength(5);
    expect(log.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: workspace,
          kind: 'profile',
          keyValue: 'prf_0000000000000000000000000000e001',
          keyVersion: KEY_ID,
        }),
        expect.objectContaining({ workspaceId: workspace, kind: 'phone', keyValue: 'hash-ee02', coverage: 'unavailable' }),
        expect.objectContaining({ workspaceId: workspace, kind: 'email', keyValue: 'hash-ee01', keyVersion: KEY_ID, erasureId }),
      ]),
    );
    expect(log.exclusionKeys).toEqual(
      expect.arrayContaining([expect.objectContaining({ workspaceId: workspace, id: KEY_ID, wrappedKey: WRAPPED, active: true })]),
    );

    // The restored snapshot is older than the erasure: same workspace, no keys yet.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [workspace]);
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed.keys).toBe(5);
    expect(replayed.exclusionKeys).toBe(1);
    const rows = await restored.db.admin.query<{
      kind: string;
      key_value: string;
      key_version: string;
      erasure_id: string;
      coverage: string;
    }>('SELECT kind, key_value, key_version, erasure_id, coverage FROM erasure_keys WHERE workspace_id = $1 ORDER BY kind, key_value', [
      workspace,
    ]);
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.find((r) => r.kind === 'email')).toMatchObject({
      key_value: 'hash-ee01',
      key_version: KEY_ID,
      erasure_id: erasureId,
      coverage: 'full',
    });
    expect(rows.rows.find((r) => r.kind === 'phone')?.coverage).toBe('unavailable');
    const keys = await restored.db.admin.query<{ id: string; wrapped_key: Buffer; active: boolean; purpose: string }>(
      'SELECT id, wrapped_key, active, purpose FROM data_keys WHERE workspace_id = $1 AND purpose = $2',
      [workspace, 'exclusion'],
    );
    expect(keys.rows).toEqual([{ id: KEY_ID, wrapped_key: WRAPPED, active: true, purpose: 'exclusion' }]);

    // A second replay changes nothing: the ledger and keys are additive and idempotent.
    const again = await replayErasures(restored.url.toString(), log);
    expect(again.keys).toBe(0);
    expect(again.exclusionKeys).toBe(0);
    const count = await restored.db.admin.query<{ n: string }>('SELECT count(*)::text AS n FROM erasure_keys WHERE workspace_id = $1', [
      workspace,
    ]);
    expect(count.rows[0]?.n).toBe('5');
  }, 60_000);

  it('replays an exclusion key for a workspace with no erasure or ledger rows', async () => {
    const live = await createDisposableDb('erasure_keys_only_live');
    const restored = await createDisposableDb('erasure_keys_only_restored');
    open.push(live, restored);
    const workspace = live.workspace;
    // Hashed event rows exist, so the key exists and matters; no erasure has happened yet, so
    // there is no erasure or ledger row to create the replay bucket.
    await live.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, active, purpose)
       VALUES ($1, $2, 'kek_test', $3, true, 'exclusion')`,
      [workspace, KEY_ID, WRAPPED],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.erasures).toEqual([]);
    expect(log.keys).toEqual([]);
    expect(log.exclusionKeys).toEqual([expect.objectContaining({ workspaceId: workspace, id: KEY_ID, wrappedKey: WRAPPED })]);

    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [workspace]);
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ exclusionKeys: 1, keys: 0 });
    const keys = await restored.db.admin.query<{ id: string; wrapped_key: Buffer; active: boolean }>(
      "SELECT id, wrapped_key, active FROM data_keys WHERE workspace_id = $1 AND purpose = 'exclusion'",
      [workspace],
    );
    expect(keys.rows).toEqual([{ id: KEY_ID, wrapped_key: WRAPPED, active: true }]);
  }, 60_000);

  it('activates the key the ledger references over a newer active key in the snapshot', async () => {
    const live = await createDisposableDb('erasure_keys_conflict_live');
    const restored = await createDisposableDb('erasure_keys_conflict_restored');
    open.push(live, restored);
    const workspace = live.workspace;
    await live.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, active, purpose) VALUES
         ($1, $2, 'kek_test', $3, false, 'exclusion'),
         ($1, $4, 'kek_test', $3, true, 'exclusion')`,
      [workspace, OLD_KEY_ID, WRAPPED, KEY_ID],
    );
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id)
       VALUES ($1, 'profile', $2, $3, 'era_conflict')`,
      [workspace, 'c'.repeat(64), KEY_ID],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.exclusionKeys?.map((key) => [key.id, key.active] as const).sort()).toEqual([
      [OLD_KEY_ID, false],
      [KEY_ID, true],
    ]);

    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [workspace]);
    // The snapshot holds a different active exclusion key (minted after it was taken).
    await restored.db.admin.query(
      `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, active, purpose)
       VALUES ($1, 'dk_snapshot_only', 'kek_test', $2, true, 'exclusion')`,
      [workspace, Buffer.from('snapshot-key')],
    );
    await replayErasures(restored.url.toString(), log);
    const keys = await restored.db.admin.query<{ id: string; active: boolean }>(
      "SELECT id, active FROM data_keys WHERE workspace_id = $1 AND purpose = 'exclusion' ORDER BY id",
      [workspace],
    );
    // Exactly one active key, and it is the one the replayed ledger references.
    expect(keys.rows).toEqual([
      { id: OLD_KEY_ID, active: false },
      { id: KEY_ID, active: true },
      { id: 'dk_snapshot_only', active: false },
    ]);
  }, 60_000);

  it('replays the publication generation and never lets a snapshot lower it (#1037 part 2)', async () => {
    const live = await createDisposableDb('erasure_generation_live');
    const restored = await createDisposableDb('erasure_generation_restored');
    open.push(live, restored);
    const workspace = live.workspace;
    await live.db.admin.query(
      `INSERT INTO erasure_generations (workspace_id, generation) VALUES ($1, 7)
       ON CONFLICT (workspace_id) DO UPDATE SET generation = 7`,
      [workspace],
    );
    const log = await readErasureLog(live.url.toString());
    expect(log.generations).toEqual([{ workspaceId: workspace, generation: 7 }]);

    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [workspace]);
    // The snapshot was taken after three publications; ClickHouse already saw seven.
    await restored.db.admin.query('INSERT INTO erasure_generations (workspace_id, generation) VALUES ($1, 3)', [workspace]);
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed.generations).toBe(1);
    let current = await restored.db.admin.query<{ generation: string }>(
      'SELECT generation FROM erasure_generations WHERE workspace_id = $1',
      [workspace],
    );
    expect(Number(current.rows[0]?.generation)).toBe(7);

    // A stale log (an older attempt's capture) must not move it back.
    await replayErasures(restored.url.toString(), {
      erasures: [],
      tombstones: [],
      generations: [{ workspaceId: workspace, generation: 3 }],
    });
    current = await restored.db.admin.query<{ generation: string }>('SELECT generation FROM erasure_generations WHERE workspace_id = $1', [
      workspace,
    ]);
    expect(Number(current.rows[0]?.generation)).toBe(7);
  }, 60_000);

  it('skips keys of a workspace the restored snapshot does not contain', async () => {
    const live = await createDisposableDb('erasure_keys_skip_live');
    const restored = await createDisposableDb('erasure_keys_skip_restored');
    open.push(live, restored);
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id)
       VALUES ($1, 'profile', 'prf_skip', 'dk_skip', 'era_skip')`,
      [live.workspace],
    );
    const log = await readErasureLog(live.url.toString());
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ keys: 0, skipped: 1 });
  }, 60_000);
});
