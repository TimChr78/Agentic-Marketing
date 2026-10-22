import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres database, so test files run one at a time.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/server'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
