import { defineConfig, devices } from '@playwright/test';
import { e2eBase } from './e2e/ports';

// Visual regression (#433): the stable route subset from e2e/visual.spec.ts against committed
// baselines, on its own so the functional e2e stays fast.
//
//   pnpm e2e:visual                 # builds the UI, starts the seeded server, compares
//   pnpm e2e:visual --update-snapshots   # deliberately re-record every baseline (review the diff)
//   E2E_BASE=http://localhost:5173 pnpm e2e:visual   # against a running dev UI and seeded server
//
// Baselines are Linux screenshots: record them in the official Playwright container
// (mcr.microsoft.com/playwright:v1.64.1-noble, the same image CI uses) so they match CI.
const executablePath = process.env.CHROMIUM || undefined;

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'visual.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // A rounded corner or an anti-aliased glyph may shift a pixel; a layout or colour change may not.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  reporter: [['list']],
  outputDir: 'test-results/visual',
  use: {
    baseURL: e2eBase,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // Chromium needs this where /dev/shm is the container default of 64 MB.
    launchOptions: { executablePath, args: ['--disable-dev-shm-usage'] },
  },
  webServer: process.env.E2E_BASE
    ? undefined
    : {
        command: 'pnpm --filter @agentic-marketing/web build:live && npx tsx apps/server/test/e2e/server.ts',
        url: `${e2eBase}/healthz`,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
      },
});
