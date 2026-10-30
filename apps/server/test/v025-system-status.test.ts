import { ADAPTER_TRACKING } from '@agentic-marketing/artifacts';
import { adapters } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// system.status is what `am smoke` uses instead of the admin-only emailProviders.list, so a narrow
// API token can check provider coverage without learning an address, host or secret (#133).

const PORT = testPort(3412);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let workspaceId: string;
let token = '';

const status = (bearer: string) =>
  fetch(`${t.base}/v1/system.status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: '{}',
  });

beforeAll(async () => {
  t = await startTestServer('test_system_status', PORT);
  owner = await t.signUp(`status-${Date.now()}@example.com`);
  workspaceId = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
  const api = t.api(owner, workspaceId);
  token = (await api.call('apiTokens.create', { name: 'status reader', scopes: ['artifacts:read'] })).token;
  await api.call('emailProviders.create', {
    name: 'Secret relay',
    adapter: 'smtp',
    config: { host: 'smtp.secret.example', port: 587, user: 'relay-user' },
    secrets: { password: 'hunter2' },
    fromEmail: 'news@secret.example',
    useFor: ['transactional', 'marketing'],
  });
}, 60_000);

afterAll(() => t?.close());

describe('system.status', () => {
  it('answers a token with only artifacts:read and exposes no provider secrets', async () => {
    const res = await status(token);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.serverVersion).toBe('string');
    expect(body.serverVersion.length).toBeGreaterThan(0);
    expect(body.emailProvider).toEqual({
      configured: true,
      marketing: true,
      transactional: true,
      adapter: 'smtp',
      tracking: 'none',
    });
    expect(body.pendingApprovals).toBe(0);

    const text = JSON.stringify(body);
    for (const secret of ['smtp.secret.example', 'relay-user', 'hunter2', 'news@secret.example']) {
      expect(text).not.toContain(secret);
    }
  });

  it('counts approvals that are waiting for a person', async () => {
    const api = t.api(owner, workspaceId);
    const note = await api.call('artifacts.create', {
      type: 'note',
      name: 'Needs review',
      content: { title: 'Needs review', body: 'Waiting for a person' },
    });
    const submitted = await api.call('artifacts.requestPublish', { artifactId: note.artifactId, note: 'Please review' });
    expect(submitted.status).toBe('in_review');

    const body = await (await status(token)).json();
    expect(body.pendingApprovals).toBe(1);
  });

  it('reports missing provider coverage without inventing an adapter', async () => {
    const emptyWs = await t.workspaceWith([[owner, 'owner']], 'none');
    const emptyApi = t.api(owner, emptyWs);
    const emptyToken = (await emptyApi.call('apiTokens.create', { name: 'empty status', scopes: ['artifacts:read'] })).token;

    const res = await fetch(`${t.base}/v1/system.status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${emptyToken}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emailProvider).toEqual({
      configured: false,
      marketing: false,
      transactional: false,
      adapter: null,
      tracking: null,
    });
  });
});

describe('system.status tracking mapping', () => {
  it('matches what each e-mail adapter declares', () => {
    expect(ADAPTER_TRACKING).toEqual(Object.fromEntries(Object.entries(adapters).map(([id, a]) => [id, a.tracking])));
  });
});
