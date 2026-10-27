import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, rejects, startTestServer, type User } from './harness';

// Password step-up on token widening (#61) is rate limited like sign-in: five wrong passwords in
// the window lock the person out for a while, even if the next password is right. A correct
// password before the limit forgets earlier typos.

const PORT = 3421;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;

beforeAll(async () => {
  t = await startTestServer('test_step_up', PORT, {
    STEP_UP_MAX_FAILURES: '5',
    STEP_UP_WINDOW_SECONDS: '60',
    STEP_UP_LOCKOUT_SECONDS: '3',
  });
  owner = await t.signUp(`stepup-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);

afterAll(() => t?.close());

const widen = (id: string, password: string) =>
  t.api(owner, ws).call('apiTokens.update', { id, scopes: ['artifacts:read', 'artifacts:write'], password });

const wrong = (id: string) => rejectPassword(id, 'not-the-password');
async function rejectPassword(id: string, password: string) {
  const err = await rejects(widen(id, password));
  expect(err.status).toBe(403);
  return err;
}

describe('token step-up rate limit', () => {
  it('refuses further attempts after five wrong passwords, and audits the failures', async () => {
    const api = t.api(owner, ws);
    const token = await api.call('apiTokens.create', { name: 'step-up target', scopes: ['artifacts:read'] });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const err = await wrong(token.id);
      expect(err.message).toBe('The password is not correct.');
    }

    const blocked = await wrong(token.id);
    expect(blocked.message).toMatch(/Too many incorrect password attempts/);
    expect(blocked.message).toMatch(/after \d{4}-\d{2}-\d{2}T/);

    const audit = await api.call('audit.list', { target: token.id, limit: 100 });
    const failures = audit.entries.filter((entry) => entry.command === 'apiTokens.update' && !entry.ok);
    expect(failures.filter((entry) => entry.error?.includes('The password is not correct.')).length).toBeGreaterThanOrEqual(5);
    expect(failures.some((entry) => entry.error?.includes('Too many incorrect password attempts'))).toBe(true);

    // The lockout is short in this test; once it passes the right password works again.
    await new Promise((r) => setTimeout(r, 3_300));
    expect((await widen(token.id, PASSWORD)).steppedUp).toBe(true);
  }, 20_000);

  it('resets the failure count after a correct password', async () => {
    const api = t.api(owner, ws);
    const token = await api.call('apiTokens.create', { name: 'step-up reset', scopes: ['artifacts:read'] });

    for (let attempt = 1; attempt <= 4; attempt++) await wrong(token.id);
    expect((await widen(token.id, PASSWORD)).steppedUp).toBe(true);

    // Narrow again without a password, then another four typos. If success had not reset the
    // count, the next correct attempt would hit the five-failure limit and be refused.
    await api.call('apiTokens.update', { id: token.id, scopes: ['artifacts:read'] });
    for (let attempt = 1; attempt <= 4; attempt++) await wrong(token.id);
    expect((await widen(token.id, PASSWORD)).steppedUp).toBe(true);
  }, 20_000);
});
