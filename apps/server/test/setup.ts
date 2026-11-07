import { buildTestCli } from '../../../test-support/cli';
import { prepareTemplateDatabase, TEMPLATE_DB } from './harness';

// Vitest global setup for the server project: migrate one template database, then every test
// file's database is a copy of it (startTestServer); bundle the CLI once so the CLI tests spawn a
// built artifact instead of compiling it with tsx on every call. Workers start after this and
// inherit the env.
export default async function setup() {
  await prepareTemplateDatabase();
  process.env.AM_TEST_TEMPLATE = TEMPLATE_DB;
  process.env.AM_TEST_CLI = await buildTestCli();
}
