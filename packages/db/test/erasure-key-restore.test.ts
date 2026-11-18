import { afterAll, describe, expect, it } from 'vitest';
import { readErasureLog, replayErasures } from '../src/erasures';
import { createDisposableDb, hasTestDatabase } from './disposable';

// #1037 part 1: a restore must carry the durable erasure-key ledger. A backup taken before an
// erasure would otherwise bring the person back and leave nothing for read-time exclusion to match
// against. The replay only copies pseudonymous ids and keyed hashes; it never decrypts.

const open: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
afterAll(async () => {
  for (const d of open) await d.close().catch(() => {});
});

describe.skipIf(!hasTestDatabase())('restore recreates the erasure-key ledger (#1037)', () => {
  it('reads every key of an erasure and replays it idempotently', async () => {
    const live = await createDisposableDb('erasure_keys_live');
    const restored = await createDisposableDb('erasure_keys_restored');
    open.push(live, restored);
    const workspace = live.workspace;
    const erasureId = 'era_0000000000000000000000000000ee01';
    const recordedAt = new Date('2026-11-01T10:00:00.000Z');
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, recorded_at) VALUES
         ($1, 'profile', 'prf_0000000000000000000000000000e001', '', $2, $3),
         ($1, 'anonymous_id', 'anon-ee01', '', $2, $3),
         ($1, 'user_id', 'user-ee01', '', $2, $3),
         ($1, 'email', 'hash-ee01', 'dk_ee01', $2, $3),
         ($1, 'phone', 'hash-ee02', 'dk_ee01', $2, $3)`,
      [workspace, erasureId, recordedAt],
    );

    const log = await readErasureLog(live.url.toString());
    expect(log.keys).toHaveLength(5);
    expect(log.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: workspace,
          kind: 'profile',
          keyValue: 'prf_0000000000000000000000000000e001',
          keyVersion: '',
        }),
        expect.objectContaining({ workspaceId: workspace, kind: 'email', keyValue: 'hash-ee01', keyVersion: 'dk_ee01', erasureId }),
      ]),
    );

    // The restored snapshot is older than the erasure: same workspace, no keys yet.
    await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [workspace]);
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed.keys).toBe(5);
    const rows = await restored.db.admin.query<{ kind: string; key_value: string; key_version: string; erasure_id: string }>(
      'SELECT kind, key_value, key_version, erasure_id FROM erasure_keys WHERE workspace_id = $1 ORDER BY kind, key_value',
      [workspace],
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.find((r) => r.kind === 'email')).toMatchObject({
      key_value: 'hash-ee01',
      key_version: 'dk_ee01',
      erasure_id: erasureId,
    });

    // A second replay changes nothing: the ledger is additive and idempotent.
    const again = await replayErasures(restored.url.toString(), log);
    expect(again.keys).toBe(0);
    const count = await restored.db.admin.query<{ n: string }>('SELECT count(*)::text AS n FROM erasure_keys WHERE workspace_id = $1', [
      workspace,
    ]);
    expect(count.rows[0]?.n).toBe('5');
  }, 60_000);

  it('skips keys of a workspace the restored snapshot does not contain', async () => {
    const live = await createDisposableDb('erasure_keys_skip_live');
    const restored = await createDisposableDb('erasure_keys_skip_restored');
    open.push(live, restored);
    await live.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id)
       VALUES ($1, 'profile', 'prf_skip', '', 'era_skip')`,
      [live.workspace],
    );
    const log = await readErasureLog(live.url.toString());
    const replayed = await replayErasures(restored.url.toString(), log);
    expect(replayed).toMatchObject({ keys: 0, skipped: 1 });
  }, 60_000);
});
