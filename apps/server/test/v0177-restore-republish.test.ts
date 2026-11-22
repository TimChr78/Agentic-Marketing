import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { erasureLedgerChecker } from '@agentic-marketing/db';
import { clickHouseStore } from '@agentic-marketing/events';
import { runErasureCleanupOnce, subjectKeyHasher } from '@agentic-marketing/profiles';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BackupManifest, createBackup, exportClickHouse, restoreBackup } from '../src/ops/backup-lib';
import { APP_ROLE, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// #1194 review: a restore can pair a Postgres snapshot that already contains a completed cleanup
// job with a ClickHouse point that predates publication (an older `--clickhouse` file, a
// Postgres-only restore after ClickHouse loss, or a fresh target whose dump carries the job). The
// replay no longer reopens completed jobs; the restore reconciles `erased_subjects` from the
// **restored** `erasure_keys` ledger after the final ClickHouse load and only then marks the jobs
// published. These tests read through the protected path with no scheduler running, so the
// exclusion has to be in place when `am restore` returns.

const PORT = testPort(3595);
const DB = 'test_v0177_restore_republish';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const stamp = Date.now();
const AT = '2026-11-12T10:00:00.000Z';
const PERSON = { anonymousId: `anon-restore-${stamp}`, userId: `user-restore-${stamp}` };

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let owner: User;
let ws = '';
let backupPath = '';
let backupDir = '';
let cleanup: (() => Promise<void>) | undefined;
let serverClosed = false;

async function createPerson(label: string) {
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

async function hashesFor(person: { profileId: string; anonymousId: string; userId: string }) {
  const hasher = await subjectKeyHasher({ db: t.srv.db, kp: t.srv.keyProvider })(ws);
  try {
    return {
      profile: await hasher.hash('profile', person.profileId),
      anonymous: await hasher.hash('anonymous_id', person.anonymousId),
      user: await hasher.hash('user_id', person.userId),
      version: hasher.version,
    };
  } finally {
    hasher.dispose();
  }
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

function rawInsert(eventId: string, anonymousId: string, userId: string, profileId: string, hashes: Record<string, string>) {
  return `INSERT INTO events
    (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id, profile_id,
     properties, traits, context, consent, subject_profile, subject_anonymous, subject_user, subject_key_version, subject_coverage)
    SELECT toUUID(${sqlString(ws)}), ${sqlString(eventId)}, 'src_raw', toDateTime64(${sqlString(AT)}, 3, 'UTC'),
           toDateTime64(${sqlString(AT)}, 3, 'UTC'), 'track', ${sqlString(`Late ${eventId}`)}, ${sqlString(anonymousId)},
           ${sqlString(userId)}, ${sqlString(profileId)}, '{}', '{}', '{}', map(),
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
 * If `erased_subjects` is missing the restored ledger's keys, this returns the erased person.
 */
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

async function protectedRead(person: { anonymousId: string; userId: string }) {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(t.dbName).toString(), max: 2 });
  const store = clickHouseStore({
    url: CH_URL,
    database: t.dbName,
    hasErasures: erasureLedgerChecker({ admin: pool }),
  });
  try {
    return await store.eventsOf(ws, { anonymousIds: [person.anonymousId], userIds: [person.userId] });
  } finally {
    await store.close();
    await pool.end();
  }
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT, {}, { erasureCleanup: false, erasurePurge: false });
  owner = await t.signUp(`republish-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const person = await createPerson('a11ce');
  const hashes = await hashesFor(person);
  // A row written before the erasure is in the older ClickHouse export below, so restoring that
  // file still leaves something a protected read must exclude.
  await ch(rawInsert('older-point', person.anonymousId, person.userId, person.profileId, hashes));
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
  // A late direct write that survived the final sweep is hidden by the published ledger.
  await ch(rawInsert('late-after-erase', person.anonymousId, person.userId, person.profileId, hashes));

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
    await rm(olderDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  };
}, 240_000);

afterAll(async () => {
  await cleanup?.();
  if (t && !serverClosed) await t.close();
});

describe('a restore reconciles erasure exclusions itself (#1194)', () => {
  it('refuses to restore while an app process is still connected', async () => {
    await expect(restoreBackup({ dir: backupPath, env: restoreEnv(testDatabaseUrl(t.dbName).toString()), log: () => {} })).rejects.toThrow(
      /application process\(es\) are still connected/,
    );
  }, 60_000);

  it('publishes the restored ledger before returning, so a protected read excludes the person', async () => {
    const person = PERSON;
    // Model a ClickHouse point that predates publication while Postgres still has the completed
    // job: nothing in the live log needs replaying, so only the restored ledger can repair this.
    await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
    expect(await chCount(`SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = '${ws}'`)).toBe(0);

    await t.close();
    serverClosed = true;
    await restoreBackup({ dir: backupPath, env: restoreEnv(testDatabaseUrl(t.dbName).toString()), log: () => {} });

    // No scheduler ran: the exclusion has to be in place when the restore returns.
    expect(await protectedRead(person)).toEqual([]);
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(t.dbName).toString() });
    try {
      const { rows } = await pool.query<{ state: string; published_at: Date | null }>(
        'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
        [ws],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'complete' });
      expect(rows[0]!.published_at).toBeInstanceOf(Date);
      const marker = await pool.query('SELECT 1 FROM installation_settings WHERE key = $1', ['erasure_restore_reconciliation']);
      expect(marker.rowCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 180_000);

  it('covers a fresh target, whose dump carries the completed job but has no live log to replay', async () => {
    const target = await createEmptyDatabase('restore_fresh_target');
    const pool = new pg.Pool({ connectionString: target.url, max: 2 });
    try {
      await ch(`DELETE FROM erased_subjects WHERE workspace_id = '${ws}'`);
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
      expect(await protectedRead(PERSON)).toEqual([]);
      const job = await pool.query<{ state: string; published_at: Date | null }>(
        'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1',
        [ws],
      );
      expect(job.rows[0]).toMatchObject({ state: 'complete' });
      expect(job.rows[0]!.published_at).toBeInstanceOf(Date);
    } finally {
      await pool.end().catch(() => {});
      await target.drop();
    }
  }, 240_000);

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
    expect(await protectedRead(PERSON)).toEqual([]);
  }, 300_000);
});
