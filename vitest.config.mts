import { defineConfig } from 'vitest/config';

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
];

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'docs', include: docs } },
      { extends: true, test: { name: 'packages', include: ['packages/*/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'web', include: ['apps/web/test/**/*.test.{ts,tsx}'], environment: 'jsdom' } },
      {
        extends: true,
        test: {
          name: 'server',
          include: ['apps/server/test/**/*.test.ts'],
          exclude: docs,
          globalSetup: ['apps/server/test/setup.ts'],
          maxWorkers: serverWorkers,
          fileParallelism: serverWorkers > 1,
          // Its own worker count needs its own group: after the quick projects.
          sequence: { groupOrder: 1 },
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
