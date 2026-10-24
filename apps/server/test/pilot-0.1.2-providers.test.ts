import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type User } from './harness';

// Pilot follow-up (0.1.2): the webhook URL admins copy must use the public links origin, and a
// lost URL can be rotated. The admin URL and the links URL deliberately differ here.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
const ADMIN = 'http://localhost:3299';
const LINKS = 'https://links.pilot.example';

beforeAll(async () => {
  t = await startTestServer('test_pilot_providers', 3299, { PUBLIC_URL: ADMIN, PUBLIC_LINKS_URL: LINKS });
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(() => t?.close());

const relay = {
  name: 'Relay',
  adapter: 'smtp' as const,
  config: { host: '127.0.0.1', port: 2527, requireTls: false, events: 'postmark' },
  secrets: { password: 'relay-password' },
  fromEmail: 'news@example.com',
  fromName: 'Pilot',
  useFor: [] as ('transactional' | 'marketing')[],
};

describe('e-mail provider credentials and webhook URLs', () => {
  it('builds the full webhook URL from PUBLIC_LINKS_URL, not the admin URL, and round-trips replyTo', async () => {
    const api = t.api(owner);
    const created = await api.call('emailProviders.create', { ...relay, replyTo: 'replies@example.com' });
    expect(created.webhookPath).toMatch(/^\/hooks\/email\/epr_[0-9a-f]{32}\/[A-Za-z0-9_-]+$/);
    expect(created.webhookUrl).toBe(`${LINKS}${created.webhookPath}`);
    expect(created.webhookUrl.startsWith(ADMIN)).toBe(false);

    const listed = (await api.call('emailProviders.list', {})).providers.find((p) => p.id === created.id);
    expect(listed?.replyTo).toBe('replies@example.com');

    expect((await api.call('emailProviders.update', { id: created.id, replyTo: 'hello@example.com' })).replyTo).toBe('hello@example.com');
    expect((await api.call('emailProviders.update', { id: created.id, replyTo: null })).replyTo).toBeNull();
  });

  it('rotates the token: the old webhook path is rejected and the new one accepts events', async () => {
    const api = t.api(owner);
    const created = await api.call('emailProviders.create', relay);
    const rotated = await api.call('emailProviders.rotateWebhook', { id: created.id });

    expect(rotated.webhookPath).not.toBe(created.webhookPath);
    expect(rotated.webhookUrl).toBe(`${LINKS}${rotated.webhookPath}`);

    const bounce = {
      RecordType: 'Bounce',
      Type: 'HardBounce',
      ID: 7,
      Description: 'Unknown user',
      MessageID: 'pm-x',
      BouncedAt: '2026-10-23T09:00:00Z',
      Metadata: { am_message_id: 'msg_missing' },
    };
    const old = await fetch(`${t.base}${created.webhookPath}`, { method: 'POST', body: JSON.stringify(bounce) });
    expect(old.status).toBe(404);
    const fresh = await fetch(`${t.base}${rotated.webhookPath}`, { method: 'POST', body: JSON.stringify(bounce) });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ ok: true, events: 0 });
  });
});
