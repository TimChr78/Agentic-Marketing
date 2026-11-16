import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './harness';
import {
  classifyRunDatabases,
  type DatabaseRow,
  ensureTemplateDatabase,
  isTemplateDatabase,
  migrationsFingerprint,
  quoteIdent,
  templateDatabaseName,
  templateMarker,
  templatesToDrop,
  withTemplateLock,
} from './template-db';

// The migrated template is shared by every checkout on the test stack, so two runs starting at the
// same moment must build it once and reuse it. The advisory lock is what makes that true: each
// "run" here is a separate connection, exactly like a separate process.

const adminUrl = () => testDatabaseUrl('postgres').toString();
const clients: pg.Client[] = [];

async function connect() {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end().catch(() => {})));
});

describe('the template database', () => {
  it('is named after the migration files, so an edit produces a new one', () => {
    const first = migrationsFingerprint();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(migrationsFingerprint()).toBe(first);
    expect(templateDatabaseName(first)).toBe(`am_tpl_${first}`);
    expect(templateMarker(first)).not.toContain('"');
  });

  it('refuses a database that claims to be a template but is not complete', async () => {
    const client = await connect();
    const name = `am_tpl_probe_${randomBytes(4).toString('hex')}`;
    const marker = templateMarker('probe');
    let builds = 0;
    const build = async () => {
      builds++;
    };

    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    try {
      expect((await withTemplateLock(client, () => ensureTemplateDatabase(client, { name, marker, build }))).built).toBe(true);
      expect((await withTemplateLock(client, () => ensureTemplateDatabase(client, { name, marker, build }))).built).toBe(false);
      expect(builds).toBe(1);

      // A build that stopped before the marker (a killed run) is replaced, not reused.
      await client.query(`COMMENT ON DATABASE ${quoteIdent(name)} IS 'am-test-template:stale'`);
      expect((await withTemplateLock(client, () => ensureTemplateDatabase(client, { name, marker, build }))).built).toBe(true);
      expect(builds).toBe(2);
    } finally {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
  });

  it('builds once when two runs start at the same moment', async () => {
    const name = `am_tpl_race_${randomBytes(4).toString('hex')}`;
    const marker = templateMarker('race');
    const [first, second] = await Promise.all([connect(), connect()]);
    let builds = 0;
    const build = async () => {
      builds++;
      // Long enough that the second run is certainly waiting on the lock while the first builds.
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    const run = (client: pg.Client) => withTemplateLock(client, () => ensureTemplateDatabase(client, { name, marker, build }));

    await first.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    try {
      const results = await Promise.all([run(first), run(second)]);

      expect(results.map((result) => result.built).sort()).toEqual([false, true]);
      expect(builds).toBe(1);
      const { rows } = await first.query<{ marker: string | null }>(
        `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1`,
        [name],
      );
      expect(rows[0]?.marker).toBe(marker);
    } finally {
      await first.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
  }, 30_000);
});

describe('the stale run database sweeper', () => {
  const hour = 3_600_000;
  const now = Date.parse('2026-11-16T12:00:00Z');
  const row = (name: string, ageHours: number | null, active = 0): DatabaseRow => ({
    name,
    active,
    created: ageHours === null ? null : new Date(now - ageHours * hour),
  });

  it('recognises templates, including the old run-scoped names', () => {
    expect(isTemplateDatabase('am_tpl_0123456789ab')).toBe(true);
    expect(isTemplateDatabase('am_rabc_test_template')).toBe(true);
    expect(isTemplateDatabase('am_rabc_cli_session')).toBe(false);
    expect(isTemplateDatabase('am_test')).toBe(false);
  });

  it('drops only old, idle run databases, never a template or its own run', () => {
    const result = classifyRunDatabases(
      [
        row('am_other_test_p1', 7),
        row('am_other_cli_session', 7),
        row('am_other_test_young', 5),
        row('am_other_test_busy', 7, 2),
        row('am_other_test_undated', null),
        row('am_tpl_0123456789ab', 999),
        row('am_other_test_template', 999),
        row('am_test', 999),
        row('am_app', 999),
        row('am_rabc_test_own', 7),
      ],
      { run: 'rabc', now },
    );

    expect(result.drop).toEqual(['am_other_test_p1', 'am_other_cli_session']);
    expect(result.found).toBe(6);
    expect(result.skipped.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['am_other_test_young', 'am_other_test_busy', 'am_other_test_undated', 'am_rabc_test_own']),
    );
  });

  it('keeps the newest templates and never an undated one', () => {
    const names = templatesToDrop(
      [
        row('am_tpl_aaaaaaaaaaaa', 30),
        row('am_tpl_bbbbbbbbbbbb', 20),
        row('am_tpl_cccccccccccc', 10),
        row('am_tpl_dddddddddddd', 5),
        row('am_tpl_eeeeeeeeeeee', null),
      ],
      3,
    );

    expect(names).toEqual(['am_tpl_aaaaaaaaaaaa']);
  });
});
