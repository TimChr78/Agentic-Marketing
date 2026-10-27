import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { startTestServer } from '../harness';
import { PEOPLE, seed } from './seed';

// A seeded server for UI development, screenshots and Playwright:
//   pnpm --filter @agentic-marketing/web build && npx tsx apps/server/test/e2e/server.ts
// Serves the built UI and the API on http://localhost:3100 (E2E_PORT). Every person's password
// is `correct-horse-battery-staple`. Stop with Ctrl-C; the next start re-creates the database.

const port = Number(process.env.E2E_PORT ?? 3100);
const t = await startTestServer(process.env.E2E_DB ?? 'e2e', port, {
  PUBLIC_URL: `http://localhost:${port}`,
  PUBLIC_LINKS_URL: `http://localhost:${port}`,
  TRUSTED_ORIGINS: 'http://localhost:5173',
});
// The signup form confirms to the site's welcome page, which the fixtures port below plays: a
// real cross-origin redirect after the confirm POST, with no DNS and no request interception.
const fixturesBase = `http://127.0.0.1:${port + 1}`;
const s = await seed(t, { confirmedUrl: `${fixturesBase}/welcome` });

// Test-only fixtures on the next port (never part of the product): the links a subscriber would
// get by e-mail, signed with this server's key, so the hosted-page specs can click them in a
// real browser (#115).
const fixtures = new Hono();
fixtures.get('/forms', (c) => c.json(s.forms));
fixtures.get('/welcome', (c) => c.html('<h1>Welcome aboard</h1>'));
fixtures.post('/confirm-link', async (c) => {
  const { form, anonymousId } = await c.req.json<{ form: string; anonymousId: string }>();
  const { rows } = await t.srv.db.admin.query<{ published_version: number }>('SELECT published_version FROM artifacts WHERE id = $1', [
    form,
  ]);
  const token = t.srv.email.links.sign({
    k: 'doi',
    w: s.ws,
    f: form,
    v: rows[0].published_version,
    a: anonymousId,
    s: new Date().toISOString(),
    x: Date.now() + 86_400_000,
  });
  return c.json({ url: `${t.base}/f/confirm/${token}` });
});
fixtures.post('/unsubscribe-link', async (c) => {
  const { profileId } = await c.req.json<{ profileId: string }>();
  const token = t.srv.email.links.sign({ w: s.ws, p: profileId, u: 'marketing_email', m: `e2e-${Date.now()}` });
  return c.json({ url: `${t.base}/u/${token}` });
});
fixtures.post('/preferences-link', async (c) => {
  const { profileId } = await c.req.json<{ profileId: string }>();
  const token = t.srv.email.links.sign({ w: s.ws, p: profileId, u: 'marketing_email', m: `e2e-pref-${Date.now()}` });
  return c.json({ url: `${t.base}/u/p/${token}` });
});
const fixturesHttp = serve({ fetch: fixtures.fetch, port: port + 1, hostname: '127.0.0.1' });

console.log(`\nReady on ${t.base}`);
for (const [role, p] of Object.entries(PEOPLE)) console.log(`  ${role.padEnd(8)} ${p.email}`);
console.log(`  password correct-horse-battery-staple\n  agent token ${s.token}\n`);
const stop = async () => {
  fixturesHttp.close();
  await t.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
