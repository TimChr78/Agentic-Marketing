import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@agentic-marketing/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Commands } from '../src/registry';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// #885 round 2: end-to-end proof through the real executor. A credential that appears in an
// unexpected driver error must not reach the HTTP/command response, the audit log or the agent
// ledger. The sweep's unit tests choose the branch; these run the actual command surface.

const SECRET = 'probe-secret';
const FIXED = 'The command failed with an unexpected error.';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let reader: User;
let ws = '';
let providerBase = '';
let templateId = '';
let profileId = '';
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url?.endsWith('/email/sending/send')) {
      const sent = JSON.parse(body || '{}') as { to?: string };
      if (sent.to === reader.email) return json(500, { success: false, errors: [{ message: 'driver failure: password=probe-secret' }] });
      return json(200, { success: true, result: { message_id: 'cf_1', delivered: [sent.to] } });
    }
    if (req.url === '/connector/fail') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('driver failure: password=probe-secret');
    }
    if (req.url === '/token') return json(400, { error: 'invalid_grant', error_description: 'password=probe-secret' });
    json(404, {});
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  providerBase = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  t = await startTestServer('test_error_text_sweep', testPort(3494));
  owner = await t.signUp(`sweep-owner-${Date.now()}@example.com`);
  reader = await t.signUp(`sweep-reader-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [owner, 'owner'],
    [reader, 'viewer'],
  ]);
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Cloudflare probe',
    adapter: 'cloudflare',
    config: { accountId: '0'.repeat(32), apiBase: providerBase },
    secrets: { apiToken: 'x'.repeat(24) },
    fromEmail: 'news@example.com',
    useFor: ['marketing', 'transactional'],
  });
  const template = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Sweep template',
    content: {
      purpose: 'marketing_email',
      subject: 'Sweep',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text><mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    },
  });
  templateId = template.artifactId;
  await api.call('profiles.import', {
    label: 'Sweep probe',
    rows: [{ email: `sweep-person-${Date.now()}@example.com`, consent: [] }],
  });
  profileId = await eventually(async () => (await api.call('profiles.list', { limit: 100 })).profiles[0]?.id ?? '', Boolean);
}, 120_000);

afterAll(async () => {
  await t?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

/** Every audit entry's error text for one command. */
async function auditText(command: string) {
  const { rows } = await t.srv.db.admin.query<{ error: string | null }>(
    'SELECT error FROM audit_log WHERE workspace_id = $1 AND command = $2',
    [ws, command],
  );
  return rows.map((r) => r.error ?? '').join('\n');
}

/** Every agent-ledger failure recorded for one command. */
async function ledgerText(command: string) {
  const { rows } = await t.srv.db.admin.query<{ error: string | null }>(
    'SELECT error FROM agent_actions WHERE workspace_id = $1 AND command = $2',
    [ws, command],
  );
  return rows.map((r) => r.error ?? '').join('\n');
}

async function agentClient(scopes: string[]) {
  const token = await t.api(owner).call('apiTokens.create', { name: `sweep ${scopes.join(' ')}`, scopes: scopes as never });
  return createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
}

async function everyStoredText() {
  const { rows } = await t.srv.db.admin.query<{ text: string }>(
    `SELECT coalesce(error, '') AS text FROM audit_log WHERE workspace_id = $1
     UNION ALL
     SELECT coalesce(error, '') AS text FROM agent_actions WHERE workspace_id = $1`,
    [ws],
  );
  return rows.map((r) => r.text).join('\n');
}

describe('templates.preview and templates.check (#885 round 2)', () => {
  it('does not leak an unexpected render/service failure into the response, audit or ledger', async () => {
    const agent = await agentClient(['artifacts:read', 'profiles:pii']);

    const unwrap = vi.spyOn(t.srv.keyProvider, 'unwrap').mockRejectedValue(new Error('driver failure: password=probe-secret'));
    try {
      const err = await rejects(agent.call('templates.preview', { artifactId: templateId, profileId }));
      expect(err.code).toBe('internal');
      expect(JSON.stringify(err)).not.toContain(SECRET);
    } finally {
      unwrap.mockRestore();
    }
    expect(await auditText('templates.preview')).toBe(`internal: ${FIXED}`);
    // A read has no policy decision, so it has no agent-ledger row; when one exists it must be safe.
    expect(await ledgerText('templates.preview')).not.toContain(SECRET);

    const linksUrl = vi.spyOn(t.srv.services, 'linksUrlFor').mockRejectedValue(new Error('driver failure: password=probe-secret'));
    try {
      const err = await rejects(agent.call('templates.check', { artifactId: templateId }));
      expect(err.code).toBe('internal');
      expect(JSON.stringify(err)).not.toContain(SECRET);
    } finally {
      linksUrl.mockRestore();
    }
    expect(await auditText('templates.check')).toBe(`internal: ${FIXED}`);
    expect(await ledgerText('templates.check')).not.toContain(SECRET);
    expect(await everyStoredText()).not.toContain(SECRET);
  });
});

describe('templates.sendTest (#885 round 2)', () => {
  it('keeps a provider refusal out of a partial send’s response and stored text', async () => {
    const api = t.api(owner);
    const result = await api.call('templates.sendTest', { artifactId: templateId, to: [owner.email, reader.email] });
    const failed = result.messages.find((m) => m.email === reader.email)!;
    expect(failed.status).toBe('failed');
    expect(result.messages.find((m) => m.email === owner.email)?.status).toBe('sent');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.skipped.map((s) => s.reason).join(' ')).not.toContain(SECRET);
    expect(await auditText('templates.sendTest')).not.toContain(SECRET);
    expect(await everyStoredText()).not.toContain(SECRET);
  });

  it('keeps the all-failed AppError safe in the response, audit and agent ledger', async () => {
    const agent = await agentClient(['artifacts:write']);
    const err = await rejects(agent.call('templates.sendTest', { artifactId: templateId, to: [reader.email] }));
    expect(err.code).toBe('conflict');
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(err.message).toContain('refused the test e-mail');
    expect(await auditText('templates.sendTest')).not.toContain(SECRET);
    expect(await ledgerText('templates.sendTest')).not.toContain(SECRET);
    expect(await everyStoredText()).not.toContain(SECRET);
  });
});

describe('connections.list after an OAuth refusal (#885 round 2)', () => {
  it('stores and returns the provider’s code, never its credential', async () => {
    const api = t.api(owner);
    const connection = await api.call('connections.create', {
      connector: 'oauth_http',
      name: 'Sweep OAuth',
      settings: {
        baseUrl: `${providerBase}/api`,
        authorizeUrl: `${providerBase}/authorize`,
        tokenUrl: `${providerBase}/token`,
        scopes: ['read'],
      },
      secrets: { clientId: 'client', clientSecret: 'secret' },
    });
    const { url } = await api.call('connections.authorize', { id: connection.id });
    const state = new URL(url).searchParams.get('state')!;
    const callback = await fetch(`${t.base}/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
    expect(callback.status).toBe(400);
    const page = await callback.text();
    expect(page).toContain('invalid_grant');
    expect(page).not.toContain(SECRET);

    const agent = await agentClient(['artifacts:read']);
    const listed = (await agent.call('connections.list', {})).connections.find((c) => c.id === connection.id)!;
    expect(listed.oauth?.status).toBe('error');
    expect(listed.oauth?.error).toContain('invalid_grant');
    expect(listed.oauth?.error).not.toContain(SECRET);
    expect(await everyStoredText()).not.toContain(SECRET);
  });
});

describe('a connector action (#885 round 2)', () => {
  it('turns an unexpected connector failure into the fixed audit and ledger text', async () => {
    const api = t.api(owner);
    const connection = await api.call('connections.create', {
      connector: 'http',
      name: 'Sweep HTTP',
      settings: { baseUrl: `${providerBase}/connector` },
      secrets: { headers: {} },
    });
    const agent = await agentClient(['messages:send']);
    const err = await rejects(
      agent.call('connections.runAction', { id: connection.id, action: 'request', input: { method: 'GET', path: 'fail' } }),
    );
    expect(err.code).toBe('internal');
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(await auditText('connections.runAction')).toBe(`internal: ${FIXED}`);
    expect(await ledgerText('connections.runAction')).toBe(FIXED);
    expect(await everyStoredText()).not.toContain(SECRET);
  });
});
