import { startTestServer } from '../harness';
import { PEOPLE, seed } from './seed';

// A seeded server for UI development, screenshots and Playwright:
//   pnpm --filter @agentic-marketing/web build && npx tsx apps/server/test/e2e/server.ts
// Serves the built UI and the API on http://localhost:3100 (E2E_PORT). Every person's password
// is `correct-horse-battery-staple`. Stop with Ctrl-C; the next start re-creates the database.

const port = Number(process.env.E2E_PORT ?? 3100);
const t = await startTestServer('e2e', port, {
  PUBLIC_URL: `http://localhost:${port}`,
  PUBLIC_LINKS_URL: `http://localhost:${port}`,
  TRUSTED_ORIGINS: 'http://localhost:5173',
});
const s = await seed(t);
console.log(`\nReady on ${t.base}`);
for (const [role, p] of Object.entries(PEOPLE)) console.log(`  ${role.padEnd(8)} ${p.email}`);
console.log(`  password correct-horse-battery-staple\n  agent token ${s.token}\n`);
const stop = async () => {
  await t.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
