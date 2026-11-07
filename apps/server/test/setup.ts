import { buildTestCli, cleanupTestCli, ensureTestRunId } from '../../../test-support/cli';
import { dropRunDatabases, prepareTemplateDatabase, TEMPLATE_DB } from './harness';

// Vitest global setup for the server project: migrate one template database, then every test
// file's database is a copy of it (startTestServer); bundle the CLI once so the CLI tests spawn a
// built artifact instead of compiling it with tsx on every call. Workers start after this and
// inherit the env. The CLI artifact's run id is chosen before it is built, so workers and teardown
// agree on one directory (#518). Teardown removes this run's CLI directory and drops this run's own
// databases, ClickHouse databases and NATS namespaces by prefix (#515); AM_TEST_KEEP_DB=1 keeps the
// databases so a failure can be inspected. Both hooks are named exports: Vitest ignores a named
// teardown beside a default setup.
export async function setup() {
  ensureTestRunId();
  await prepareTemplateDatabase();
  process.env.AM_TEST_TEMPLATE = TEMPLATE_DB;
  process.env.AM_TEST_CLI = await buildTestCli();
}

export async function teardown() {
  try {
    await cleanupTestCli();
  } finally {
    await dropRunDatabases();
  }
}
