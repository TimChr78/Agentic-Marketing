import { defineConfig } from 'vitest/config';
import { runId } from './packages/db/test/run.ts';

// One namespace for the whole run: every project and worker inherits AM_TEST_RUN, and the test
// harness scopes Postgres, ClickHouse, NATS and Valkey names with it. CI leaves it empty, so its
// own service containers keep the fixed names and ports they always had.
if (runId) process.env.AM_TEST_RUN = runId;

// Pin the time zone before anything creates a Date in this process. Workers inherit the value and
// `test.env` sets it again inside each test process, so a machine in CET or DST produces the same
// results. Product code keeps passing a workspace time zone where it needs one.
process.env.TZ = 'UTC';

// Four projects (#172):
//   docs      documentation that must agree with the code; no services.
//   packages  package unit tests, in parallel. events and secrets reach NATS/ClickHouse/OpenBao
//             under their own names, so they run in parallel too.
//   web       the admin UI's unit and component tests, in a DOM.
//   server    full-stack tests. Every file gets its own Postgres/ClickHouse database, NATS namespace,
//             Valkey prefix and port block (harness.ts), so files run in parallel workers;
//             setup.ts migrates a template database once and each file copies it.
// TEST_WORKERS sets the server project's worker count (default 4; 1 runs the files one at a time).
const serverWorkers = Number(process.env.TEST_WORKERS ?? 4);
const docs = [
  'apps/server/test/docs-consistency.test.ts',
  'apps/server/test/mcp-tools-doc.test.ts',
  'apps/server/test/action-classes.test.ts',
  'apps/server/test/docs-determinism.test.ts',
  'apps/server/test/changelog.test.ts',
  'apps/server/test/release-tooling.test.ts',
];

export default defineConfig({
  test: {
    // Every project, including global setup and workers, runs in UTC.
    env: { TZ: 'UTC' },
    projects: [
      { extends: true, test: { name: 'docs', include: docs } },
      {
        extends: true,
        // Files use their own NATS/ClickHouse names, but the host is shared: an unbounded worker
        // pool starves a dynamic import past the 20 s timeout under load. Use the same cap as
        // the server project (TEST_WORKERS, default 4).
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          maxWorkers: serverWorkers,
          // Its own worker count needs its own group: after the quick projects and before server.
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.{ts,tsx}', 'apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          include: ['apps/server/test/**/*.test.ts'],
          exclude: docs,
          globalSetup: ['apps/server/test/setup.ts'],
          maxWorkers: serverWorkers,
          fileParallelism: serverWorkers > 1,
          // Its own worker count needs its own group: after the quick projects and packages.
          sequence: { groupOrder: 2 },
        },
      },
    ],
    // Off by default; `pnpm test:ci` turns it on and CI uploads the report. A baseline, not a gate.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'reports/coverage',
    },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
