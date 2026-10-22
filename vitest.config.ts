import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres server, so test files run one at a time.
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'packages', include: ['packages/*/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'server', include: ['apps/server/test/**/*.test.ts'] } },
    ],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
