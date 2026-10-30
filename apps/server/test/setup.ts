import { prepareTemplateDatabase, TEMPLATE_DB } from './harness';

// Vitest global setup for the server project: migrate one template database, then every test
// file's database is a copy of it (startTestServer). Workers start after this and inherit the env.
export default async function setup() {
  await prepareTemplateDatabase();
  process.env.AM_TEST_TEMPLATE = TEMPLATE_DB;
}
