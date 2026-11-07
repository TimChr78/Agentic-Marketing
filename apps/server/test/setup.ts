import { dropRunDatabases, prepareTemplateDatabase, TEMPLATE_DB } from './harness';

// Vitest global setup for the server project: migrate one template database, then every test
// file's database is a copy of it (startTestServer). Workers start after this and inherit the env.
// Teardown drops this run's own databases, ClickHouse databases and NATS namespaces by prefix;
// AM_TEST_KEEP_DB=1 keeps them so a failure can be inspected.
export default async function setup() {
  await prepareTemplateDatabase();
  process.env.AM_TEST_TEMPLATE = TEMPLATE_DB;
  return async () => {
    await dropRunDatabases();
  };
}
