import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  APP_DATABASE_APPLICATION_NAME,
  erasureLedgerChecker,
  RESTORE_ADVISORY_LOCK_KEY,
  RESTORE_APPLICATION_NAME,
} from '@agentic-marketing/db';
import { clickHouseStore } from '@agentic-marketing/events';
import { runErasureCleanupOnce, subjectKeyHasher } from '@agentic-marketing/profiles';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCli } from '../../../test-support/cli';
import {
  type BackupManifest,
  createBackup,
  exportClickHouse,
  restoreBackup,
  restoreErasureLogPath,
  restoreLockPath,
} from '../src/ops/backup-lib';
import { acquireRestoreStartupLock, clearRestoreFenceForUrl, finishRestoreReconciliation } from '../src/ops/restore-reconcile';
import { APP_ROLE, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// #1194 review: a restore can pair a Postgres snapshot that already contains a completed cleanup
// job with a ClickHouse point that predates publication (an older `--clickhouse` file, a
// Postgres-only restore after ClickHouse loss, or a fresh target whose dump carries the job). The
// replay no longer reopens completed jobs; the restore reconciles `erased_subjects` from the
// **restored** `erasure_keys` ledger after the final ClickHouse load and only then clears the
// fence. These tests read through the protected path with no scheduler running, so the exclusion
// has to be in place when `am restore` returns — and the bypass test proves that it is the
// reconciliation, not some other restore step, that hides the pre-erasure row.

const PORT = testPort(3595);
const DB = 'test_v0177_restore_republish';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const stamp = Date.now();
const AT = '2026-11-12T10:00:00.000Z';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));

type Server = Awaited<ReturnType<typeof startTestServer>>;
interface Person {
  profileId: string;
  anonymousId: string;
  userId: string;
}
interface Hashes {
  profile: string;
  anonymous: string;
  user: string;
  version: string;
}
let t: Server;
let owner: User;
let ws = '';
let backupPath = '';
let backupDir = '';
let person: Person;
let fixtureHashes: Hashes;
let cleanup: (() => Promise<void>) | undefined;
let serverClosed = false;

async function createPerson(label: string): Promise<Person> {
  const profileId = `prf_${label
    .replaceAll(/[^0-9a-f]/g, '')
    .padEnd(32, '0')
    .slice(0, 32)}`;
  const anonymousId = `anon-${label}-${stamp}`;
  const userId = `user-${label}-${stamp}`;
  await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, profileId]);
  for (const [type, value] of [
    ['user_id', userId],
    ['anonymous_id', anonymousId],
  ] as const)
    await t.srv.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      ws,
      profileId,
      type,
      value,
    ]);
  return { profileId, anonymousId, userId };
}

const cleanupDeps = () => ({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, hot: t.srv.hot });

const makeDue = (erasureId: string) =>
  t.srv.db.admin.query(
    `UPDATE erasure_cleanup_jobs SET next_attempt_at = now()
      WHERE workspace_id = $1 AND erasure_id = $2 AND state <> 'complete'`,
    [ws, erasureId],
  );

async function completeErasure(erasureId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await runErasureCleanupOnce(cleanupDeps(), {
      finalSweepMs: 0,
      outboxWaitSeconds: 0,
      coverageWaitSeconds: 0,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    });
    // A round completes whichever jobs it claimed; only this erasure's own job decides the wait.
    const { rows } = await t.srv.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [ws, erasureId],
    );
    if (rows[0]?.state === 'complete' && rows[0].published_at !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await makeDue(erasureId);
  }
  throw new Error(`erasure ${erasureId} did not complete`);
}

async function hashesFor(who: Person): Promise<Hashes> {
  const hasher = await subjectKeyHasher({ db: t.srv.db, kp: t.srv.keyProvider })(ws);
  try {
    return {
      profile: await hasher.hash('profile', who.profileId),
      anonymous: await hasher.hash('anonymous_id', who.anonymousId),
      user: await hasher.hash('user_id', who.userId),
      version: hasher.version,
    };
  } finally {
    hasher.dispose();
  }
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

function rawInsert(eventId: string, who: Person, hashes: Hashes) {
  return `INSERT INTO events
    (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id, profile_id,
     properties, traits, context, consent, subject_profile, subject_anonymous, subject_user, subject_key_version, subject_coverage)
    SELECT toUUID(${sqlString(ws)}), ${sqlString(eventId)}, 'src_raw', toDateTime64(${sqlString(AT)}, 3, 'UTC'),
           toDateTime64(${sqlString(AT)}, 3, 'UTC'), 'track', ${sqlString(`Late ${eventId}`)}, ${sqlString(who.anonymousId)},
           ${sqlString(who.userId)}, ${sqlString(who.profileId)}, '{}', '{}', '{}', map(),
           ${sqlString(hashes.profile ?? '')}, ${sqlString(hashes.anonymous ?? '')}, ${sqlString(hashes.user ?? '')},
           ${sqlString(hashes.version ?? '')}, 'full'
    FROM numbers(1)`;
}

async function ch(query: string) {
  const url = new URL(`${CH_URL}/`);
  url.searchParams.set('database', t.dbName);
  // The shared stack turns row policies on by default; every read must name its workspace.
  url.searchParams.set('SQL_workspace', ws);
  const res = await fetch(url, { method: 'POST', body: query });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
  return text;
}

async function eventually<T>(fn: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function chCount(query: string): Promise<number> {
  const url = new URL(`${CH_URL}/`);
  url.searchParams.set('database', t.dbName);
  url.searchParams.set('SQL_workspace', ws);
  const text = await fetch(url, { method: 'POST', body: `${query} FORMAT JSONEachRow` });
  if (!text.ok) throw new Error(`ClickHouse ${text.status}: ${await text.text()}`);
  const line = (await text.text()).trim().split('\n')[0] ?? '{}';
  return Number((JSON.parse(line) as { n?: number }).n ?? 0);
}

/** The restore's environment: the target database plus the ClickHouse database this test uses. */
const restoreEnv = (databaseUrl: string) => ({
  DATABASE_URL: databaseUrl,
  APP_DB_ROLE: APP_ROLE.appRole,
  APP_DB_PASSWORD: APP_ROLE.appRolePassword,
  CLICKHOUSE_URL: CH_URL,
  CLICKHOUSE_DATABASE: t.dbName,
});

/**
 * Reads like the application does, through the protected views, from a process with no scheduler.
 * The ledger decision comes from the **restored target's** Postgres, which is what decides whether
 * a read takes the protected path; the ClickHouse database is the one this restore loaded.
 */
async function protectedRead(databaseUrl: string, who: Person) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const store = clickHouseStore({
    url: CH_URL,
    database: t.dbName,
    hasErasures: erasureLedgerChecker({ admin: pool }),
  });
  try {
    return await store.eventsOf(ws, { anonymousIds: [who.anonymousId], userIds: [who.userId] });
  } finally {
    await store.close();
    await pool.end();
  }
}

/** A fresh, empty database: no app pool (the restore refuses one), so it is created with a client. */
async function createEmptyDatabase(prefix: string): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `am_${prefix}_${process.pid}_${stamp}`;
  const maintenance = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${name}`);
  } finally {
    await maintenance.end();
  }
  return {
    name,
    url: testDatabaseUrl(name).toString(),
    async drop() {
      const client = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

/** The raised fence row, straight from the target database. */
async function fenceRow(databaseUrl: string): Promise<{ backup: string; started_at: Date } | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ backup: string; started_at: Date }>(
      'SELECT backup, started_at FROM public.restore_fence WHERE id = 1',
    );
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
}

/**
 * What a server start would do: take the shared restore lock, read the fence, release. The message
 * is null when a start is allowed. A shared lock is compatible with the test server's own shared
 * lock; only a restore's exclusive lock conflicts.
 */
async function startupBlock(databaseUrl: string): Promise<string | null> {
  try {
    const lock = await acquireRestoreStartupLock(databaseUrl, { waitMs: 500 });
    await lock.release();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * A row for the erased identity in the ClickHouse point. A protected read can only prove the
 * reconciliation by hiding something that exists: with no row, the assertion passes even when the
 * final step is bypassed (#1194 review).
 */
async function ensureRawEvent(eventId: string, who: Person, hashes: Hashes): Promise<void> {
  if ((await chCount(`SELECT count() AS n FROM events FINAL WHERE event_id = '${eventId}'`)) === 0)
    await ch(rawInsert(eventId, who, hashes));
  await eventually(
    () => chCount(`SELECT count() AS n FROM events FINAL WHERE event_id = '${eventId}'`),
    (count) => count === 1,
  );
}

/** Runs the built `am` artifact, as an operator would. */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return buildTestCli().then(
    (path) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = execFile(process.execPath, [path, ...args], {
          cwd: root,
          env: { ...process.env, ...env },
          maxBuffer: 4 * 1024 * 1024,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        child.stdin?.end();
      }),
  );
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT, {}, { erasureCleanup: false, erasurePurge: false });
  owner = await t.signUp(`republish-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  person = await createPerson('a11ce');
  fixtureHashes = await hashesFor(person);
  // A row written before the erasure is in the older ClickHouse export below, so restoring that
  // file still leaves something a protected read must exclude.
  await ch(rawInsert('older-point', person, fixtureHashes));
  await eventually(
    () => chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'older-point'"),
    (count) => count === 1,
  );

  const olderDir = await mkdtemp(join(tmpdir(), 'am-older-clickhouse-'));
  const olderTables = await exportClickHouse({
    url: CH_URL,
    database: t.dbName,
    databaseUrl: testDatabaseUrl(t.dbName).toString(),
    outDir: olderDir,
    log: () => {},
  });

  const erased = await t.api(owner, ws).call('profiles.erase', { profileId: person.profileId, reason: 'restore keeps job' });
  await completeErasure(erased.erasureId);

  backupDir = await mkdtemp(join(tmpdir(), 'am-restore-republish-'));
  const created = await createBackup({
    dir: backupDir,
    databaseUrl: testDatabaseUrl(t.dbName).toString(),
    env: { DATABASE_URL: testDatabaseUrl(t.dbName).toString(), APP_DB_ROLE: APP_ROLE.appRole, APP_DB_PASSWORD: APP_ROLE.appRolePassword },
    log: () => {},
  });
  backupPath = created.dir;
  // Attach the pre-erasure ClickHouse point to the post-erasure Postgres snapshot: exactly the
  // `am restore --clickhouse` shape in the review. The files are hash-checked by the restore.
  await cp(join(olderDir, 'clickhouse'), join(backupPath, 'clickhouse'), { recursive: true });
  const manifestPath = join(backupPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  manifest.clickhouse = { tables: olderTables };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  cleanup = async () => {
    // A simulated pg_restore failure deliberately leaves its capture behind; remove the files this
    // run created so the next run (and the operator) never sees a stale one.
    await rm(restoreErasureLogPath(backupPath), { force: true });
    await rm(restoreLockPath(backupPath), { force: true });
    await rm(olderDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  };
}, 240_000);

afterAll(async () => {
  await cleanup?.();
  if (t && !serverClosed) await t.close();
});

describe('a restore reconciles erasure exclusions itself (#1194)', () => {
  it('refuses to restore while a server holds the restore lock, even with its pools idle', async () => {
    // A real server process takes the shared lock for its lifetime before it migrates. Idle pools
    // are exactly the case the old `pg_stat_activity` check missed: no connection says "busy", but
    // the server could wake up and republish during the load.
    await eventually(
      async () => t.srv.db.app.waitingCount === 0 && t.srv.db.admin.waitingCount === 0,
      (idle) => idle,
    );
    await expect(restoreBackup({ dir: backupPath, env: restoreEnv(testDatabaseUrl(t.dbName).toString()), log: () => {} })).rejects.toThrow(
      /Stop every app, worker and scheduler first/,
    );
  }, 60_000);

  it('still names a connected app process that does not hold the lock (drain diagnostic)', async () => {
    // A process from a build that announces the app name but takes no shared lock (or one whose
    // lock connection was lost before it exited) is caught by the documented drain check.
    if (!serverClosed) {
      await t.close();
      serverClosed = true;
    }
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    const legacy = new pg.Client({ connectionString: databaseUrl, application_name: APP_DATABASE_APPLICATION_NAME });
    await legacy.connect();
    try {
      await expect(restoreBackup({ dir: backupPath, env: restoreEnv(databaseUrl), log: () => {} })).rejects.toThrow(
        /application process\(es\) are still connected/,
      );
    } finally {
      await legacy.end();
    }
  }, 60_000);

  it('waits for a previous restore’s database work and refuses after its bound', async () => {
    // The advisory lock lives on one session; a previous run may still be writing through other
    // connections. A successor waits for those, and refuses rather than racing them (#1204 review).
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    const stale = new pg.Client({ connectionString: databaseUrl, application_name: RESTORE_APPLICATION_NAME });
    await stale.connect();
    try {
      const started = Date.now();
      await expect(restoreBackup({ dir: backupPath, env: restoreEnv(databaseUrl), log: () => {}, drainTimeoutMs: 300 })).rejects.toThrow(
        /a previous restore's work is still running/,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      // It refused before the destructive steps: no fence was raised for this attempt.
      expect(await fenceRow(databaseUrl)).toBeNull();
    } finally {
      await stale.end();
    }
  }, 120_000);

  it('refuses to start while a restore holds the exclusive lock', async () => {
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    const holder = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RESTORE_ADVISORY_LOCK_KEY]);
      expect(rows[0]?.locked).toBe(true);
      expect(await startupBlock(databaseUrl)).toMatch(/A restore is running/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [RESTORE_ADVISORY_LOCK_KEY]).catch(() => {});
      await holder.end();
    }
    expect(await startupBlock(databaseUrl)).toBeNull();
  }, 60_000);

  it('takes the lock before `am migrate` runs a migration', async () => {
    // An empty target: if the lock were taken after `migrate` (or not at all), the CLI would create
    // the schema. With a restore holding the exclusive lock it must refuse before that.
    const target = await createEmptyDatabase('restore_lock_before_migrate');
    const holder = new pg.Client({ connectionString: target.url });
    await holder.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RESTORE_ADVISORY_LOCK_KEY]);
      expect(rows[0]?.locked).toBe(true);
      const result = await cli(['migrate'], {
        DATABASE_URL: target.url,
        APP_DB_ROLE: APP_ROLE.appRole,
        APP_DB_PASSWORD: APP_ROLE.appRolePassword,
        AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
        MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
        CLICKHOUSE_URL: CH_URL,
        CLICKHOUSE_DATABASE: t.dbName,
        NATS_URL: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
        NATS_NAMESPACE: t.dbName,
        VALKEY_URL: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
        VALKEY_PREFIX: t.dbName,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/A restore is running/);
      const probe = new pg.Client({ connectionString: target.url });
      await probe.connect();
      try {
        const { rows: schema } = await probe.query<{ present: boolean }>(
          "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
        );
        expect(schema[0]?.present).toBe(false);
      } finally {
        await probe.end();
      }
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [RESTORE_ADVISORY_LOCK_KEY]).catch(() => {});
      await holder.end();
      await target.drop();
    }
  }, 120_000);

  it('reports a lost lock connection so the process can exit', async () => {
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    let lostWith = '';
    const lock = await acquireRestoreStartupLock(databaseUrl, { onLost: (err) => (lostWith = err.message) });
    try {
      const terminator = new pg.Client({ connectionString: databaseUrl });
      await terminator.connect();
      try {
        await terminator.query('SELECT pg_terminate_backend($1)', [lock.pid]);
      } finally {
        await terminator.end();
      }
      await eventually(
        async () => lostWith,
        (message) => message.length > 0,
      );
      expect(lostWith).toMatch(/terminat|connection/i);
    } finally {
      await lock.release();
    }
  }, 60_000);

  it('publishes the restored ledger before returning, so a protected read excludes the person', async () => {
    // Model a ClickHouse point that predates publication while Postgres still has the completed
    // job: nothing in the live log needs replaying, so only the restored ledger can repair this.
    await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
    expect(await chCount(`SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = '${ws}'`)).toBe(0);
    // The Postgres-only shape leaves ClickHouse untouched, so this row is what a bypassed final
    // step would serve; without it the assertion below would pass for the wrong reason.
    await ensureRawEvent('pg-only-point', person, fixtureHashes);

    if (!serverClosed) {
      await t.close();
      serverClosed = true;
    }
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    await restoreBackup({ dir: backupPath, env: restoreEnv(databaseUrl), log: () => {} });

    // No scheduler ran: the exclusion has to be in place when the restore returns.
    expect(await chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'pg-only-point'")).toBe(1);
    expect(await protectedRead(databaseUrl, person)).toEqual([]);
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const { rows } = await pool.query<{ state: string; published_at: Date | null }>(
        'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
        [ws],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'complete' });
      expect(rows[0]!.published_at).toBeInstanceOf(Date);
    } finally {
      await pool.end();
    }
    // The fence was raised before pg_restore and survives it; only reconciliation clears it.
    expect(await fenceRow(databaseUrl)).toBeNull();
    expect(await startupBlock(databaseUrl)).toBeNull();
  }, 180_000);

  it('fails that Postgres-only case when the reconciliation is bypassed', async () => {
    // The control the review asked for: the same shape and the same row, with the last step
    // skipped. The protected read returns the row, which is what a failed (or stubbed) final step
    // would serve, and the fence keeps a server from starting.
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
    await ensureRawEvent('pg-only-point', person, fixtureHashes);
    await restoreBackup({ dir: backupPath, env: restoreEnv(databaseUrl), log: () => {}, skipReconciliation: true });

    expect(await chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'pg-only-point'")).toBe(1);
    expect((await protectedRead(databaseUrl, person)).map((event) => event.eventId)).toContain('pg-only-point');
    expect(await fenceRow(databaseUrl)).toMatchObject({ backup: backupPath });
    expect(await startupBlock(databaseUrl)).toMatch(/did not finish reconciling erasure exclusions/);

    await finishRestoreReconciliation({ databaseUrl, env: restoreEnv(databaseUrl), log: () => {} });
    expect(await protectedRead(databaseUrl, person)).toEqual([]);
    expect(await fenceRow(databaseUrl)).toBeNull();
  }, 180_000);

  it('covers a fresh target, whose dump carries the completed job but has no live log to replay', async () => {
    const target = await createEmptyDatabase('restore_fresh_target');
    const pool = new pg.Pool({ connectionString: target.url, max: 2 });
    try {
      await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
      await ensureRawEvent('fresh-target-point', person, fixtureHashes);
      await restoreBackup({
        dir: backupPath,
        env: restoreEnv(target.url),
        log: () => {},
      });
      // The restored Postgres ledger now holds the keys and the protected read uses them.
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM erasure_keys WHERE workspace_id = $1 AND coverage = 'full'",
        [ws],
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
      expect(await chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'fresh-target-point'")).toBe(1);
      expect(await protectedRead(target.url, person)).toEqual([]);
      const job = await pool.query<{ state: string; published_at: Date | null }>(
        'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
        [ws],
      );
      expect(job.rows[0]).toMatchObject({ state: 'complete' });
      expect(job.rows[0]!.published_at).toBeInstanceOf(Date);
      // The fence table existed before the replacement and was not part of the dump; the restore
      // can clear it afterwards (a dropped table would silently lose the interlock).
      expect(await fenceRow(target.url)).toBeNull();

      // The same target and row with the final step skipped: readable, and the fence stays.
      await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
      await restoreBackup({ dir: backupPath, env: restoreEnv(target.url), log: () => {}, skipReconciliation: true });
      expect(await chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'fresh-target-point'")).toBe(1);
      expect((await protectedRead(target.url, person)).map((event) => event.eventId)).toContain('fresh-target-point');
      expect(await startupBlock(target.url)).toMatch(/did not finish reconciling erasure exclusions/);
      await finishRestoreReconciliation({ databaseUrl: target.url, env: restoreEnv(target.url), log: () => {} });
      expect(await protectedRead(target.url, person)).toEqual([]);
    } finally {
      await pool.end().catch(() => {});
      await target.drop();
    }
  }, 300_000);

  it('restores an older ClickHouse file and then republishes the exclusions', async () => {
    // The backup's ClickHouse part was exported before the erasure, so loading it removes
    // `erased_subjects` for the workspace while the restored Postgres still has the completed job.
    await restoreBackup({
      dir: backupPath,
      clickhouse: true,
      env: restoreEnv(testDatabaseUrl(t.dbName).toString()),
      log: () => {},
    });
    expect(await chCount(`SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = '${ws}'`)).toBeGreaterThan(0);
    // The older point carries a row written before the erasure; the reconciliation must hide it.
    await eventually(
      () => chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'older-point'"),
      (count) => count === 1,
    );
    expect(await protectedRead(testDatabaseUrl(t.dbName).toString(), person)).toEqual([]);
  }, 300_000);

  it('leaves the pre-erasure row readable when reconciliation is bypassed, then hides it after it runs', async () => {
    // This is the control for the older-ClickHouse shape: with the last step skipped, the same
    // restore leaves that point's row readable through the protected view. Without the fence too,
    // nothing would stop a server from serving it, which is why startup refuses while it is raised.
    await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
    if ((await chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'older-point'")) === 0)
      await ch(rawInsert('older-point', person, fixtureHashes));
    const databaseUrl = testDatabaseUrl(t.dbName).toString();

    await restoreBackup({ dir: backupPath, env: restoreEnv(databaseUrl), log: () => {}, skipReconciliation: true });

    // Readable *before* reconciliation, on the restored ledger: this is what a bypassed (or
    // failed) final step would serve.
    expect(await chCount("SELECT count() AS n FROM events FINAL WHERE event_id = 'older-point'")).toBe(1);
    const readable = await protectedRead(databaseUrl, person);
    expect(readable.map((event) => event.eventId)).toContain('older-point');
    // The fence survived `pg_restore` (the dump excludes it) and blocks a server start.
    expect(await fenceRow(databaseUrl)).toMatchObject({ backup: backupPath });
    expect(await startupBlock(databaseUrl)).toMatch(/did not finish reconciling erasure exclusions/);

    // Running the real last step confirms the ledger, hides the row and clears the fence.
    await finishRestoreReconciliation({ databaseUrl, env: restoreEnv(databaseUrl), log: () => {} });
    expect(await protectedRead(databaseUrl, person)).toEqual([]);
    expect(await fenceRow(databaseUrl)).toBeNull();
    expect(await startupBlock(databaseUrl)).toBeNull();
  }, 300_000);

  it('refuses a second restore and a same-time `--clear-fence` while another holds the lock', async () => {
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    const holder = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RESTORE_ADVISORY_LOCK_KEY]);
      expect(rows[0]?.locked).toBe(true);
      await expect(restoreBackup({ dir: backupPath, env: restoreEnv(databaseUrl), log: () => {} })).rejects.toThrow(
        /another restore is running/,
      );
      // `--clear-fence` takes the same lock, so it cannot delete the fence under a live restore.
      await expect(clearRestoreFenceForUrl(databaseUrl)).rejects.toThrow(/another restore is running/);
      // A server start is refused while the restore lock is held, not only while the fence exists.
      expect(await startupBlock(databaseUrl)).toMatch(/A restore is running/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [RESTORE_ADVISORY_LOCK_KEY]).catch(() => {});
      await holder.end();
    }
    expect(await startupBlock(databaseUrl)).toBeNull();
  }, 60_000);

  it('keeps the fence when pg_restore fails, so a half-applied restore cannot serve', async () => {
    const databaseUrl = testDatabaseUrl(t.dbName).toString();
    await expect(
      restoreBackup({
        dir: backupPath,
        env: restoreEnv(databaseUrl),
        log: () => {},
        pgRestore: async () => {
          throw new Error('simulated pg_restore failure after committing part of the archive');
        },
      }),
    ).rejects.toThrow(/simulated pg_restore failure/);

    expect(await fenceRow(databaseUrl)).toMatchObject({ backup: backupPath });
    expect(await startupBlock(databaseUrl)).toMatch(/did not finish reconciling erasure exclusions/);
    // The deliberate escape hatch, and only it, can abandon the restore.
    expect(await clearRestoreFenceForUrl(databaseUrl)).toBe(true);
    expect(await startupBlock(databaseUrl)).toBeNull();
    expect(await clearRestoreFenceForUrl(databaseUrl)).toBe(false);
  }, 120_000);

  it('keeps the restore fence out of the Postgres dump', async () => {
    // The table exists in the live database (the migration created it); a dump that carried it
    // would let `pg_restore --clean` drop the fence of an interrupted restore.
    const { stdout } = await exec('pg_restore', ['--list', join(backupPath, 'postgres.dump')], { maxBuffer: 8 * 1024 * 1024 });
    expect(stdout).not.toMatch(/restore_fence/);
  }, 60_000);
});
