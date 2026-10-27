import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the admin UI against a seeded server (apps/server/test/e2e/server.ts).
//   pnpm e2e            builds the UI, starts the seeded server on :3100 and runs the tests
//   E2E_BASE=http://localhost:5173 pnpm e2e:dev   against a running Vite dev server instead
//   E2E_PORT=3120 E2E_DB=e2e_mine pnpm e2e   another port and database, so two checkouts can run at once
// Uses the system Chromium when CHROMIUM (or /usr/bin/chromium) is set, else Playwright's own.
const base = process.env.E2E_BASE ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const executablePath = process.env.CHROMIUM || undefined;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: base, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
  webServer: process.env.E2E_BASE
    ? undefined
    : {
        command: 'pnpm --filter @agentic-marketing/web build:live && npx tsx apps/server/test/e2e/server.ts',
        url: `${base}/healthz`,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
      },
});
