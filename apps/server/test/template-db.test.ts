import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { parseRunDatabaseMarker, runDatabaseMarker, runId } from '../../../packages/db/test/run';
import { freshDatabase, testDatabaseUrl } from './harness';
import {
  classifyRunDatabases,
  type DatabaseRow,
  ensureTemplateDatabase,
  hasTestStackMarker,
  quoteIdent,
  recipeFiles,
  sweepRunDatabases,
  templateDatabaseName,
  templateFingerprint,
  templateMarker,
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

describe('the template recipe inputs (#987 review)', () => {
  it('fingerprints the whole auth source and the lockfile, not only named files', () => {
    const files = recipeFiles();
    // migrateAuth → authOptions reads plugin modules such as sso.ts, which add auth columns.
    expect(files).toContain('packages/auth/src/sso.ts');
    expect(files).toContain('packages/auth/src/index.ts');
    expect(files).toContain('packages/db/src/migrate.ts');
    // The lockfile pins every schema-producing dependency (Better Auth and its plugins).
    expect(files).toContain('pnpm-lock.yaml');
  });
});

describe('the template database', () => {
  it('names the template after a fingerprint of the whole build recipe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-fingerprint-'));
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations);
    const migration = join(migrations, '0001_base.sql');
    const recipe = join(dir, 'recipe.ts');
    writeFileSync(migration, '-- base\n');
    writeFileSync(recipe, 'export const recipe = 1;\n');
    const options = {
      migrationsDir: migrations,
      files: [recipe],
      versions: { 'better-auth': '1.0.0' },
      role: { appRole: 'am_app_test' },
    };

    try {
      const base = templateFingerprint(options);
      expect(base).toMatch(/^[0-9a-f]{12}$/);
      expect(templateFingerprint(options)).toBe(base);
      expect(templateDatabaseName(base)).toBe(`am_tpl_${base}`);
      expect(templateMarker(base)).toBe(`am-test-template:${base}`);

      // Every input shapes the template, so every one of them changes the fingerprint: the SQL, a
      // new migration file, the migrator/auth sources, the Better Auth version and the app role.
      writeFileSync(migration, '-- changed\n');
      expect(templateFingerprint(options), 'migration content').not.toBe(base);
      writeFileSync(migration, '-- base\n');

      writeFileSync(join(migrations, '0002_added.sql'), '-- added\n');
      expect(templateFingerprint(options), 'a new migration file').not.toBe(base);
      rmSync(join(migrations, '0002_added.sql'));

      writeFileSync(recipe, 'export const recipe = 2;\n');
      expect(templateFingerprint(options), 'a recipe source file').not.toBe(base);
      writeFileSync(recipe, 'export const recipe = 1;\n');

      expect(templateFingerprint({ ...options, versions: { 'better-auth': '1.0.1' } }), 'the Better Auth version').not.toBe(base);
      expect(templateFingerprint({ ...options, role: { appRole: 'other' } }), 'the app role').not.toBe(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('database ownership', () => {
  it('marks a run database it creates, so the sweeper can trust the comment and not the name', async () => {
    const { dbName } = await freshDatabase('am_owned_probe');
    const client = await connect();
    try {
      const { rows } = await client.query<{ marker: string | null }>(
        `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1`,
        [dbName],
      );
      const marker = parseRunDatabaseMarker(rows[0]?.marker);
      expect(marker?.run).toBe(runId);
      expect(marker?.created).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
    }
  });
});

describe('the stale run database sweeper', () => {
  const hour = 3_600_000;
  const now = Date.parse('2026-11-16T12:00:00Z');
  const row = (name: string, run: string | null, ageHours: number | null, active = 0): DatabaseRow => ({
    name,
    active,
    created: null,
    marker: run !== null && ageHours !== null ? runDatabaseMarker(run, now - ageHours * hour) : null,
  });

  it('only considers databases a run owns through its marker', () => {
    const result = classifyRunDatabases(
      [
        row('am_other_test_p1', 'other', 7),
        row('am_other_cli_session', 'other', 7),
        row('am_other_test_young', 'other', 5),
        row('am_other_test_busy', 'other', 7, 2),
        row('am_rabc_test_own', 'rabc', 7),
        // Ordinary databases whose names look like the run convention: no marker, never candidates.
        row('am_customer_archive', null, 999),
        row('am_prod_backup', null, 999),
        row('am_tpl_0123456789ab', null, 999),
        row('am_rabc_test_template', null, 999),
      ],
      { run: 'rabc', now },
    );

    expect(result.drop).toEqual(['am_other_test_p1', 'am_other_cli_session']);
    expect(result.found).toBe(5);
    expect(result.skipped.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['am_other_test_young', 'am_other_test_busy', 'am_rabc_test_own']),
    );
  });

  it('sweeps nothing without the shared-stack marker', async () => {
    const client = await connect();
    const absent = `am_test_stack_absent_${randomBytes(4).toString('hex')}`;

    expect(await hasTestStackMarker(client, absent)).toBe(false);
    const result = await sweepRunDatabases(client, { run: 'rabc', markerDatabase: absent, now });

    expect(result.swept).toBe(false);
    expect(result.reason).toContain('not the shared test stack');
    expect(result.dropped).toEqual([]);
  });

  it('recognises the marker database the stack provisions', async () => {
    const client = await connect();
    const probe = `am_test_stack_probe_${randomBytes(4).toString('hex')}`;

    await client.query(`CREATE DATABASE ${quoteIdent(probe)}`);
    try {
      expect(await hasTestStackMarker(client, probe)).toBe(true);
    } finally {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(probe)} WITH (FORCE)`);
    }
  });
});
