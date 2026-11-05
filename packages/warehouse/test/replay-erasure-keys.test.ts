import { randomUUID } from 'node:crypto';
import { createDb, type ErasureLog, readErasureLog, replayErasures } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { erasuresForExport, pruneErasureKeys } from '../src/datasets';

// #421: restore replay inserted the erasure before deleting the restored identifiers. Migration
// 0068 derives warehouse_key_count in an AFTER INSERT trigger, so it counted an empty key table
// and stored zero, while the identifier AFTER DELETE trigger captured the keys afterwards. After a
// destination pruned those keys, a later re-enabled destination saw "zero keys" and concluded the
// person never had event-capable identifiers, reporting success instead of manual cleanup.

type Disposable = Awaited<ReturnType<typeof createDisposableDb>>;

const EPOCH = '1970-01-01T00:00:00.000Z';

async function addWorkspace(d: Disposable): Promise<string> {
  const ws = randomUUID();
  await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Replay test', 'none')", [ws]);
  return ws;
}

async function addExport(d: Disposable, ws: string, id: string, enabled: boolean): Promise<void> {
  await d.db.admin.query(
    `INSERT INTO warehouse_exports (workspace_id, id, name, kind, config, datasets, enabled, created_at)
     VALUES ($1, $2, $2, 'postgres', '{"schema":"warehouse_test"}', '{events}', $3, now() - interval '30 days')`,
    [ws, id, enabled],
  );
}

async function seedPerson(d: Disposable, ws: string, profileId: string, types: ('user_id' | 'anonymous_id' | 'email')[]): Promise<void> {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, profileId]);
  for (const [i, type] of types.entries())
    await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      ws,
      profileId,
      type,
      `${profileId}-${type}-${i}`,
    ]);
}

/** The live 0.7.5 erase order: identifiers go first, then the erasure row is recorded. */
async function liveErase(d: Disposable, ws: string, profileId: string, erasureId: string): Promise<void> {
  await d.db.admin.query('DELETE FROM identifiers WHERE workspace_id = $1 AND profile_id = $2', [ws, profileId]);
  await d.db.admin.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, profileId]);
  await d.db.admin.query(
    `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
     VALUES ($1, $2, $3, 'tester', 'restore replay regression', '{"profiles":1}')`,
    [ws, erasureId, [profileId]],
  );
}

async function logFor(d: Disposable, erasureId: string): Promise<ErasureLog> {
  const log = await readErasureLog(d.url.toString());
  return { erasures: log.erasures.filter((e) => e.id === erasureId), tombstones: [] };
}

async function countFor(d: Disposable, ws: string): Promise<number> {
  const { rows } = await d.db.admin.query<{ warehouse_key_count: number }>(
    'SELECT warehouse_key_count FROM erasures WHERE workspace_id = $1',
    [ws],
  );
  return rows[0]!.warehouse_key_count;
}

async function keyValues(d: Disposable, ws: string): Promise<string[]> {
  const { rows } = await d.db.admin.query<{ type: string; value: string }>(
    'SELECT type, value FROM warehouse_erasure_keys WHERE workspace_id = $1 ORDER BY type, value',
    [ws],
  );
  return rows.map((r) => `${r.type}:${r.value}`);
}

/** Simulate restoring a snapshot taken before the erasure: the log and captured keys are absent. */
async function restoreSnapshot(d: Disposable, ws: string): Promise<void> {
  await d.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws]);
  await d.db.admin.query('DELETE FROM erasures WHERE workspace_id = $1', [ws]);
}

describe.skipIf(!hasTestDatabase())('restore erasure replay and warehouse keys (#421)', () => {
  let d: Disposable;
  // The disposable helper's owner is a superuser, which bypasses RLS. Warehouse reads are
  // workspace-scoped by RLS, so exercise them as the migration-created app role.
  let appDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    d = await createDisposableDb('erasure_replay421');
    const appUrl = new URL(d.url.toString());
    appUrl.username = 'am_ops_test_app';
    appUrl.password = 'am_ops_test_password';
    appDb = createDb({ adminUrl: d.url.toString(), appUrl: appUrl.toString(), poolSize: 2 });
  });

  afterAll(async () => {
    await appDb?.close();
    await d?.close();
  });

  it('recaptures the restored identifiers and records a positive key count', async () => {
    const ws = await addWorkspace(d);
    const profile = 'prf_replay_keys0000000000000000000';
    await addExport(d, ws, 'wh_a', true);
    await addExport(d, ws, 'wh_b', false);
    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    await liveErase(d, ws, profile, 'era_replay_keys');
    expect(await countFor(d, ws)).toBe(2);

    const log = await logFor(d, 'era_replay_keys');
    expect(log.erasures[0]?.warehouseKeyCount).toBe(2);

    await restoreSnapshot(d, ws);
    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    const replayed = await replayErasures(d.url.toString(), log);

    expect(replayed.erasures).toBe(1);
    expect(replayed.profiles).toBe(1);
    // The bug stored zero here: the erasure trigger ran before eraseFamily captured the keys.
    expect(await countFor(d, ws)).toBe(2);
    expect(await keyValues(d, ws)).toHaveLength(2);
  });

  it('keeps the live count when the restored snapshot has no identifiers to recapture', async () => {
    const ws = await addWorkspace(d);
    const profile = 'prf_replay_known000000000000000000';
    await addExport(d, ws, 'wh_a', true);
    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    await liveErase(d, ws, profile, 'era_replay_known');
    const log = await logFor(d, 'era_replay_known');

    await restoreSnapshot(d, ws);
    // A profile whose identifiers are already absent (for example an older suppress-only cleanup):
    // replay can recapture nothing, but the live erasure knew the person had two keys.
    await seedPerson(d, ws, profile, []);

    await replayErasures(d.url.toString(), log);
    expect(await countFor(d, ws)).toBe(2);

    // A second (idempotent) replay after the keys were pruned must not reset the known count.
    await d.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws]);
    await replayErasures(d.url.toString(), log);
    expect(await countFor(d, ws)).toBe(2);
  });

  it('becomes manual cleanup after the enabled destination prunes and a disabled one is re-enabled', async () => {
    const ws = await addWorkspace(d);
    const profile = 'prf_replay_prune000000000000000000';
    await addExport(d, ws, 'wh_a', true);
    await addExport(d, ws, 'wh_b', false);
    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    await liveErase(d, ws, profile, 'era_replay_prune');
    const log = await logFor(d, 'era_replay_prune');

    await restoreSnapshot(d, ws);
    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    await replayErasures(d.url.toString(), log);

    // A processes the erasure and advances. B stays disabled, so it must not pin the keys.
    await d.db.admin.query(
      `UPDATE warehouse_exports
       SET cursors = jsonb_set(coalesce(cursors, '{}'), '{erasures}', to_jsonb((now() + interval '1 minute')::text))
       WHERE workspace_id = $1 AND id = 'wh_a'`,
      [ws],
    );
    await pruneErasureKeys(appDb, ws);
    expect(await keyValues(d, ws)).toEqual([]);

    // B is re-enabled. With no keys left it cannot locate the person's events, but the recorded
    // key count still proves they had identifiers, so this must become a manual cleanup.
    await d.db.admin.query("UPDATE warehouse_exports SET enabled = true WHERE workspace_id = $1 AND id = 'wh_b'", [ws]);
    const { rows } = await d.db.admin.query<{ created_at: Date }>(
      "SELECT created_at FROM warehouse_exports WHERE workspace_id = $1 AND id = 'wh_b'",
      [ws],
    );
    const erasures = await erasuresForExport(
      appDb,
      ws,
      EPOCH,
      new Date(Date.now() + 3_600_000).toISOString(),
      ['events'],
      new Date(rows[0]!.created_at).toISOString(),
    );

    expect(erasures).toHaveLength(1);
    expect(erasures[0]!.identifiers).toEqual([]);
    expect(erasures[0]!.uncovered).toEqual(['events']);
  });

  it('still reports a known zero as complete, unlike an unknown legacy erasure', async () => {
    const known = await addWorkspace(d);
    const knownProfile = 'prf_replay_zero0000000000000000000';
    await addExport(d, known, 'wh_a', true);
    // E-mail only: no user or anonymous id can name an event, so zero is a genuine known zero.
    await seedPerson(d, known, knownProfile, ['email']);
    await liveErase(d, known, knownProfile, 'era_replay_zero');
    expect(await countFor(d, known)).toBe(0);
    const knownLog = await logFor(d, 'era_replay_zero');
    expect(knownLog.erasures[0]?.warehouseKeyCount).toBe(0);
    await restoreSnapshot(d, known);
    await seedPerson(d, known, knownProfile, ['email']);
    await replayErasures(d.url.toString(), knownLog);
    expect(await countFor(d, known)).toBe(0);
    await d.db.admin.query(
      `UPDATE warehouse_exports
       SET cursors = jsonb_set(coalesce(cursors, '{}'), '{erasures}', to_jsonb((now() + interval '1 minute')::text))
       WHERE workspace_id = $1 AND id = 'wh_a'`,
      [known],
    );
    await pruneErasureKeys(appDb, known);
    const { rows } = await d.db.admin.query<{ created_at: Date }>(
      "SELECT created_at FROM warehouse_exports WHERE workspace_id = $1 AND id = 'wh_a'",
      [known],
    );
    const knownErasures = await erasuresForExport(
      appDb,
      known,
      EPOCH,
      new Date(Date.now() + 3_600_000).toISOString(),
      ['events'],
      new Date(rows[0]!.created_at).toISOString(),
    );
    expect(knownErasures[0]!.uncovered).toEqual([]);

    // An erasure recorded before key tracking has an unknown count, not a known zero, even though
    // the column's default is zero. It must stay an outstanding manual cleanup.
    const legacy = await addWorkspace(d);
    const legacyProfile = 'prf_replay_legacy00000000000000000';
    await addExport(d, legacy, 'wh_a', true);
    await seedPerson(d, legacy, legacyProfile, ['user_id']);
    const tracking = await d.db.admin.query<{ since: Date }>('SELECT since FROM warehouse_erasure_key_tracking LIMIT 1');
    const legacyLog: ErasureLog = {
      erasures: [
        {
          workspaceId: legacy,
          id: 'era_replay_legacy',
          profileIds: [legacyProfile],
          requestedBy: 'tester',
          reason: 'legacy',
          counts: { profiles: 1, identifiers: 1 },
          at: new Date(new Date(tracking.rows[0]!.since).getTime() - 60_000).toISOString(),
        },
      ],
      tombstones: [],
    };
    await replayErasures(d.url.toString(), legacyLog);
    await d.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [legacy]);
    const legacyErasures = await erasuresForExport(
      appDb,
      legacy,
      EPOCH,
      new Date(Date.now() + 3_600_000).toISOString(),
      ['events'],
      new Date(rows[0]!.created_at).toISOString(),
    );
    expect(legacyErasures[0]!.uncovered).toEqual(['events']);
  });

  it('preserves unknown legacy coverage after the restored tracking epoch and repeated replay', async () => {
    const ws = await addWorkspace(d);
    await addExport(d, ws, 'wh_a', true);
    await addExport(d, ws, 'wh_b', false);
    // A newer backup may have no person left to recapture; an older-format live log has no count.
    const legacy: ErasureLog = {
      erasures: [
        {
          workspaceId: ws,
          id: 'era_newer_snapshot',
          profileIds: ['prf_not_in_snapshot'],
          requestedBy: 'tester',
          reason: 'legacy count unknown',
          counts: {},
          at: new Date().toISOString(),
        },
      ],
      tombstones: [],
    };
    await replayErasures(d.url.toString(), legacy);
    expect(await countFor(d, ws)).toBe(-1);
    const roundTrip = await logFor(d, 'era_newer_snapshot');
    expect(roundTrip.erasures[0]?.warehouseKeyCount).toBeUndefined();
    await replayErasures(d.url.toString(), roundTrip);
    expect(await countFor(d, ws)).toBe(-1);
    await d.db.admin.query(
      `UPDATE warehouse_exports SET cursors = jsonb_build_object('erasures', (now() + interval '1 minute')::text)
      WHERE workspace_id = $1 AND id = 'wh_a'`,
      [ws],
    );
    await pruneErasureKeys(appDb, ws);
    await d.db.admin.query(`UPDATE warehouse_exports SET enabled = true WHERE workspace_id = $1 AND id = 'wh_b'`, [ws]);
    const events = await erasuresForExport(appDb, ws, EPOCH, new Date(Date.now() + 3_600_000).toISOString(), ['events'], EPOCH);
    expect(events[0]!.identifiers).toEqual([]);
    expect(events[0]!.uncovered).toEqual(['events']);
  });

  it('recovers an old replay zero while its captured keys still exist', async () => {
    const ws = await addWorkspace(d);
    await addExport(d, ws, 'wh_a', true);
    await seedPerson(d, ws, 'prf_old_replay_zero', ['user_id', 'anonymous_id']);
    await liveErase(d, ws, 'prf_old_replay_zero', 'era_old_replay_zero');
    await d.db.admin.query('UPDATE erasures SET warehouse_key_count = 0 WHERE workspace_id = $1', [ws]);
    const log = await logFor(d, 'era_old_replay_zero');
    expect(log.erasures[0]?.warehouseKeyCount).toBe(2);
  });

  it('reads a pre-tracking erasure on a migrated database as unknown rather than zero', async () => {
    const ws = await addWorkspace(d);
    const { rows: tracking } = await d.db.admin.query<{ since: Date }>('SELECT since FROM warehouse_erasure_key_tracking LIMIT 1');
    const beforeTracking = new Date(new Date(tracking[0]!.since).getTime() - 60_000).toISOString();
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts, at)
       VALUES ($1, 'era_replay_untracked', ARRAY['prf_untracked'], 'tester', 'legacy', '{}', $2)`,
      [ws, beforeTracking],
    );

    const log = await readErasureLog(d.url.toString());
    const erasure = log.erasures.find((e) => e.id === 'era_replay_untracked');
    // The column is zero because 0068 defaulted it, not because a capture found zero keys.
    expect(erasure?.warehouseKeyCount).toBeUndefined();
  });
});

describe.skipIf(!hasTestDatabase())('restore replay on a pre-0068 schema (#421)', () => {
  let d: Disposable;

  beforeAll(async () => {
    d = await createDisposableDb('erasure_replay_legacy');
    // A snapshot restored from before 0068 has none of the key-tracking objects. Replay must not
    // reference them and must still remove the restored person.
    await d.db.admin.query('DROP TRIGGER identifiers_warehouse_erasure ON identifiers');
    await d.db.admin.query('DROP TRIGGER warehouse_exports_drop_unused_erasure_keys ON warehouse_exports');
    await d.db.admin.query('DROP TRIGGER erasures_warehouse_captured ON erasures');
    await d.db.admin.query('DROP FUNCTION warehouse_erasure_captured()');
    await d.db.admin.query('DROP FUNCTION warehouse_capture_erasure_key()');
    await d.db.admin.query('DROP FUNCTION warehouse_drop_unused_erasure_keys()');
    await d.db.admin.query('DROP TABLE warehouse_erasure_backlog');
    await d.db.admin.query('DROP TABLE warehouse_erasure_key_tracking');
    await d.db.admin.query('DROP TABLE warehouse_erasure_keys');
    await d.db.admin.query('ALTER TABLE erasures DROP COLUMN warehouse_key_count');
  });

  afterAll(async () => {
    await d?.close();
  });

  it('reads and replays a log without warehouse key tracking', async () => {
    const ws = d.workspace;
    const profile = 'prf_replay_pre006800000000000000000';
    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    await d.db.admin.query('DELETE FROM identifiers WHERE workspace_id = $1 AND profile_id = $2', [ws, profile]);
    await d.db.admin.query('DELETE FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, profile]);
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_replay_pre0068', $2, 'tester', 'legacy', '{"profiles":1}')`,
      [ws, [profile]],
    );

    const log = await readErasureLog(d.url.toString());
    expect(log.erasures[0]?.warehouseKeyCount).toBeUndefined();

    await seedPerson(d, ws, profile, ['user_id', 'anonymous_id']);
    const replayed = await replayErasures(d.url.toString(), log);

    expect(replayed.profiles).toBe(1);
    const { rows } = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, profile]);
    expect(rows).toHaveLength(0);
  });
});
