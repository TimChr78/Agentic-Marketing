import { resetClickHouse } from '@agentic-marketing/events';
import pg from 'pg';
import { testDatabaseUrl } from './harness';

// `pnpm test:clean`: drops the databases test runs leave behind (#173). Test files keep their
// database after a run so a failure can be inspected; this removes them on the TEST_DATABASE_URL
// Postgres server and the CLICKHOUSE_URL server. Only names the harness and tests create match.

const TEST_DB = /^am_(test_|e2e|backup_|doctor_)/;

const maint = new pg.Client({ connectionString: testDatabaseUrl('postgres').toString() });
await maint.connect();
const { rows } = await maint.query<{ datname: string }>('SELECT datname FROM pg_database WHERE NOT datistemplate');
const pgDropped = rows.map((r) => r.datname).filter((name) => TEST_DB.test(name));
for (const name of pgDropped) await maint.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await maint.end();

const chUrl = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const chDropped = (await (await fetch(`${chUrl}/?query=${encodeURIComponent('SHOW DATABASES')}`)).text())
  .split('\n')
  .filter((name) => TEST_DB.test(name));
for (const name of chDropped) await resetClickHouse(chUrl, name);

console.log(`Dropped ${pgDropped.length} Postgres and ${chDropped.length} ClickHouse test databases.`);
