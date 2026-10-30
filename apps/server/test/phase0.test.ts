import type { AddressInfo } from 'node:net';
import { migrateAuth } from '@agentic-marketing/auth';
import { type ApiError, type CommandInput, createClient } from '@agentic-marketing/client';
import { hashValue, newUuid } from '@agentic-marketing/core';
import { migrate } from '@agentic-marketing/db';
import { localKeyProvider, readSecret, rewrapDataKeys } from '@agentic-marketing/secrets';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { Commands } from '../src/registry';
import { freshDatabase, connectAgent as harnessConnectAgent, testPort } from './harness';

// Phase 0 acceptance: "an MCP client and the UI can create, version and approve an artifact with
// identical rules". Runs against a fresh database on the TEST_DATABASE_URL server.

const PORT = testPort(3299);
const BASE = `http://localhost:${PORT}`;
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

let srv: ReturnType<typeof createServer>;
let http: { close: () => void };
const wsA = newUuid();
const wsB = newUuid();

type User = { email: string; cookie: string; id: string };
const users: Record<'owner' | 'reviewer' | 'viewer' | 'outsider', User> = {
  owner: { email: `owner-${Date.now()}@example.com`, cookie: '', id: '' },
  reviewer: { email: `reviewer-${Date.now()}@example.com`, cookie: '', id: '' },
  viewer: { email: `viewer-${Date.now()}@example.com`, cookie: '', id: '' },
  outsider: { email: `outsider-${Date.now()}@example.com`, cookie: '', id: '' },
};
const PASSWORD = 'correct-horse-battery-staple';

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
const api = (u: User) => createClient<Commands>({ baseUrl: BASE, headers: { cookie: u.cookie } });
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the call to fail');
};

const note = (title: string): CommandInput<Commands, 'artifacts.create'> => ({
  type: 'note',
  name: title,
  content: { title, body: 'Hello' },
});
const journey = {
  type: 'journey' as const,
  name: 'Win-back 60 days',
  content: {
    purpose: 'marketing_email',
    goal: 'Order within 14 days',
    nodes: [
      { id: 'n1', kind: 'trigger', label: 'Entered lapsed segment', config: { event: 'segment.entered' } },
      { id: 'n2', kind: 'updateProfile', label: 'Mark as lapsed', config: { trait: 'lifecycle', value: 'lapsed' } },
      { id: 'n3', kind: 'goal', label: 'Ordered', config: { event: 'order_completed', within: 'P14D' } },
    ],
  },
};

// A Client ID Metadata Document, served by a stub transport instead of the internet.
const CIMD_URL = 'https://agent.example.com/oauth/client.json';
const cimdDocument = {
  client_id: CIMD_URL,
  client_name: 'Metadata-document agent',
  redirect_uris: ['http://localhost/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
const cimdFetches: string[] = [];
const fetchCimd = async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  cimdFetches.push(url);
  if (url !== CIMD_URL) return new Response('not found', { status: 404 });
  return Response.json(cimdDocument, { headers: { 'cache-control': 'max-age=300' } });
};

const connectAgent = (u: User, permissions: string[], clientMetadataUrl?: string) =>
  harnessConnectAgent(BASE, u, permissions, clientMetadataUrl);
const structured = (r: any) => r.structuredContent as any;
const toolError = (r: any) => JSON.parse(r.content[0].text);

beforeAll(async () => {
  const db = await freshDatabase('am_test_phase0');

  const config = loadConfig({
    PORT: String(PORT),
    DATABASE_URL: db.url.toString(),
    APP_DB_ROLE: 'am_app_test',
    APP_DB_PASSWORD: 'am_app_test_password',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    MASTER_KEY,
    // /readyz checks these; use the test services wherever they run, like harness.ts.
    ...(process.env.CLICKHOUSE_URL ? { CLICKHOUSE_URL: process.env.CLICKHOUSE_URL } : {}),
    ...(process.env.NATS_URL ? { NATS_URL: process.env.NATS_URL } : {}),
    ...(process.env.VALKEY_URL ? { VALKEY_URL: process.env.VALKEY_URL } : {}),
  });
  srv = createServer(config, { cimd: { fetchClientMetadataResource: fetchCimd } });
  if (!db.migrated) {
    await migrate(srv.db.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole });
    await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db: srv.db });
  }
  await new Promise<void>((resolve) => {
    http = serve({ fetch: srv.app.fetch, port: PORT }, (_i: AddressInfo) => resolve());
  });

  for (const u of Object.values(users)) {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: u.email, password: PASSWORD, name: u.email.split('@')[0] }),
    });
    expect(res.status).toBe(200);
    u.cookie = cookieOf(res);
    u.id = (await res.json()).user.id;
  }
  await srv.db.admin.query(
    `INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Fjeldvej', 'agent_changes'), ($2, 'Other shop', 'none')`,
    [wsA, wsB],
  );
  await srv.db.admin.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'approver'), ($1, $4, 'viewer'), ($5, $6, 'owner')`,
    [wsA, users.owner.id, users.reviewer.id, users.viewer.id, wsB, users.outsider.id],
  );
}, 60_000);

afterAll(async () => {
  http?.close();
  await srv?.bus.close();
  await srv?.events.close();
  await srv?.hot.close();
  await srv?.db.close();
});

describe('people through REST and the typed client', () => {
  it('creates a draft, edits it in place, and protects against lost updates', async () => {
    const owner = api(users.owner);
    const created = await owner.call('artifacts.create', note('Launch plan'));
    expect(created).toMatchObject({ version: 1, state: 'draft' });
    expect(created.artifactId).toMatch(/^not_[0-9a-f]{32}$/);

    const v1 = await owner.call('artifacts.get', { artifactId: created.artifactId });
    const edited = await owner.call('artifacts.updateDraft', {
      artifactId: created.artifactId,
      content: { title: 'Launch plan', body: 'Hello, edited' },
      expectedContentHash: v1.version.contentHash,
    });
    expect(edited.version).toBe(1); // still the same draft

    const stale = await rejects(
      owner.call('artifacts.updateDraft', {
        artifactId: created.artifactId,
        content: { title: 'x', body: 'y' },
        expectedContentHash: v1.version.contentHash,
      }),
    );
    expect(stale.status).toBe(412);
  });

  it('rejects invalid content with details an agent can act on', async () => {
    const err = await rejects(
      api(users.owner).call('artifacts.create', {
        ...journey,
        content: { ...journey.content, nodes: [{ id: 'n1', kind: 'email', label: 'x', next: [{ to: 'zz' }] }] },
      }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('artifacts.types');
    expect(JSON.stringify(err.details)).toContain('exactly one trigger');
    expect(JSON.stringify(err.details)).toContain('unknown node');
  });

  it('publishes a person’s draft directly under "agent_changes", then versions further edits', async () => {
    const owner = api(users.owner);
    const { artifactId } = await owner.call('artifacts.create', note('Brand voice'));
    expect(await owner.call('artifacts.requestPublish', { artifactId, note: 'First version' })).toMatchObject({
      status: 'published',
      version: 1,
    });
    const v2 = await owner.call('artifacts.updateDraft', { artifactId, content: { title: 'Brand voice', body: 'Warm, direct, Nordic.' } });
    expect(v2.version).toBe(2);
    const d = await owner.call('artifacts.diff', { artifactId });
    expect(d).toMatchObject({ from: 1, to: 2 });
    expect(d.changes).toEqual([{ path: 'body', kind: 'changed', before: 'Hello', after: 'Warm, direct, Nordic.' }]);
    const h = await owner.call('artifacts.history', { artifactId });
    expect(h.versions.map((v) => [v.number, v.state, v.basedOn])).toEqual([
      [2, 'draft', 1],
      [1, 'published', null],
    ]);
  });

  it('enforces roles: a viewer can read but not write', async () => {
    const err = await rejects(api(users.viewer).call('artifacts.create', note('Nope')));
    expect(err.status).toBe(403);
    expect(err.message).toContain('Your role (viewer)');
    const list = await api(users.viewer).call('artifacts.list', {});
    expect(list.artifacts.length).toBeGreaterThan(0);
  });

  it('isolates workspaces with row-level security', async () => {
    const outsider = api(users.outsider);
    expect((await outsider.call('artifacts.list', {})).artifacts).toEqual([]);
    const { artifacts } = await api(users.owner).call('artifacts.list', {});
    const err = await rejects(outsider.call('artifacts.get', { artifactId: artifacts[0].id }));
    expect(err.status).toBe(404);
  });

  it('replays idempotent requests and refuses key reuse for a different request', async () => {
    const owner = api(users.owner);
    const a = await owner.call('artifacts.create', note('Idempotent'), { idempotencyKey: 'key-1' });
    const b = await owner.call('artifacts.create', note('Idempotent'), { idempotencyKey: 'key-1' });
    expect(b).toEqual(a);
    expect((await rejects(owner.call('artifacts.create', note('Other'), { idempotencyKey: 'key-1' }))).status).toBe(409);
  });
});

describe('agents through MCP with OAuth', () => {
  let agent: Awaited<ReturnType<typeof connectAgent>>;
  beforeAll(async () => {
    agent = await connectAgent(users.owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
  }, 30_000);
  afterAll(() => agent?.client.close());

  it('lists only the tools this agent may use (or ask for), never humans-only ones', async () => {
    const tools = (await agent.client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['artifacts.create', 'artifacts.requestPublish', 'artifacts.types', 'workspace.get']));
    for (const forbidden of [
      'approvals.approve',
      'approvals.reject',
      'secrets.set',
      'secrets.delete',
      'workspace.setApprovalPolicy',
      'members.invite',
      'members.setRole',
      'members.remove',
    ])
      expect(names).not.toContain(forbidden);
    // Allowed by the role but not granted: listed, and calling it asks the person for the scope.
    expect(tools.find((t) => t.name === 'audit.list')?.description).toContain('Needs the "audit:read" permission');
  });

  it('drafts a journey, and a person approves it under the same rules as the UI', async () => {
    const created = structured(await agent.client.callTool({ name: 'artifacts.create', arguments: journey }));
    const pub = structured(
      await agent.client.callTool({
        name: 'artifacts.requestPublish',
        arguments: { artifactId: created.artifactId, note: 'Proposed by agent' },
      }),
    );
    expect(pub).toMatchObject({ status: 'in_review', policy: 'agent_changes' });

    const owner = api(users.owner);
    const got = await owner.call('artifacts.get', { artifactId: created.artifactId });
    expect(got.version.author).toEqual({ type: 'agent', id: users.owner.id, client: agent.clientId });
    const pending = await owner.call('approvals.list', {});
    expect(pending.approvals.map((a) => a.id)).toContain(pub.approvalId);

    expect(await owner.call('approvals.approve', { approvalId: pub.approvalId })).toMatchObject({ status: 'approved', version: 1 });
    expect((await owner.call('artifacts.get', { artifactId: created.artifactId })).publishedVersion).toBe(1);
  });

  it('accepts clients identified by a Client ID Metadata Document instead of registration', async () => {
    const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(meta.client_id_metadata_document_supported).toBe(true);
    const cimdAgent = await connectAgent(users.owner, ['artifacts:read'], CIMD_URL);
    try {
      expect(cimdAgent.clientId).toBe(CIMD_URL);
      expect(cimdFetches).toContain(CIMD_URL);
      const ws = structured(await cimdAgent.client.callTool({ name: 'workspace.get', arguments: {} }));
      expect(ws.you).toMatchObject({ type: 'agent', permissions: ['artifacts:read'] });
      const { rows } = await srv.db.admin.query(`SELECT count(*)::int AS n FROM "oauthClient" WHERE "clientId" = $1`, [CIMD_URL]);
      expect(rows[0].n).toBe(1);
    } finally {
      await cimdAgent.client.close();
    }
  });

  it('returns structured, actionable tool errors', async () => {
    const res = await agent.client.callTool({ name: 'artifacts.get', arguments: { artifactId: `not_${'0'.repeat(32)}` } });
    expect(res.isError).toBe(true);
    expect(toolError(res)).toMatchObject({ error: 'not_found' });
  });

  it('gives a read-only grant read-only tools', async () => {
    const ro = await connectAgent(users.owner, ['artifacts:read']);
    try {
      const names = (await ro.client.listTools()).tools.map((t) => t.name);
      const tools = (await ro.client.listTools()).tools;
      expect(names).toContain('artifacts.list');
      expect(tools.find((t) => t.name === 'artifacts.list')?.description).not.toContain('Needs the');
      expect(tools.find((t) => t.name === 'artifacts.create')?.description).toContain('Needs the "artifacts:write" permission');
    } finally {
      await ro.client.close();
    }
  }, 30_000);
});

describe('approval policies', () => {
  it('"all_publishes" requires someone other than the requester to approve', async () => {
    const owner = api(users.owner);
    await owner.call('workspace.setApprovalPolicy', { policy: 'all_publishes' });
    try {
      const { artifactId } = await owner.call('artifacts.create', note('Four eyes'));
      const pub = await owner.call('artifacts.requestPublish', { artifactId, note: 'Please review' });
      expect(pub.status).toBe('in_review');
      const self = await rejects(owner.call('approvals.approve', { approvalId: pub.approvalId! }));
      expect(self.status).toBe(403);
      expect(self.message).toContain('someone else');
      expect(await api(users.reviewer).call('approvals.approve', { approvalId: pub.approvalId!, note: 'Looks good' })).toMatchObject({
        status: 'approved',
      });
    } finally {
      await owner.call('workspace.setApprovalPolicy', { policy: 'agent_changes' });
    }
  });

  it('a rejected version stays in history and the next edit starts a new draft', async () => {
    const owner = api(users.owner);
    await owner.call('workspace.setApprovalPolicy', { policy: 'all_publishes' });
    try {
      const { artifactId } = await owner.call('artifacts.create', note('Rejected'));
      const pub = await owner.call('artifacts.requestPublish', { artifactId, note: 'v1' });
      await api(users.reviewer).call('approvals.reject', { approvalId: pub.approvalId!, note: 'Tone is off' });
      const next = await owner.call('artifacts.updateDraft', { artifactId, content: { title: 'Rejected', body: 'Better tone' } });
      expect(next).toMatchObject({ version: 2, state: 'draft' });
    } finally {
      await owner.call('workspace.setApprovalPolicy', { policy: 'agent_changes' });
    }
  });
});

describe('secrets', () => {
  it('stores encrypted, never returns values, and keeps values out of the audit log', async () => {
    const owner = api(users.owner);
    await owner.call('secrets.set', { name: 'llm.anthropic.api_key', value: 'sk-test-123' });
    const { secrets } = await owner.call('secrets.list', {});
    expect(secrets).toEqual([expect.objectContaining({ name: 'llm.anthropic.api_key' })]);
    expect(JSON.stringify(secrets)).not.toContain('sk-test');

    const { rows } = await srv.db.admin.query(`SELECT ciphertext FROM secrets WHERE workspace_id = $1`, [wsA]);
    expect(rows[0].ciphertext.toString('utf8')).not.toContain('sk-test');
    const value = await srv.db.withWorkspace(wsA, (tx) => readSecret(tx, wsA, 'llm.anthropic.api_key', localKeyProvider(MASTER_KEY)));
    expect(value).toBe('sk-test-123');

    const { rows: audit } = await srv.db.admin.query(`SELECT input_hash FROM audit_log WHERE command = 'secrets.set'`);
    expect(audit[0].input_hash).toBe(hashValue({ name: 'llm.anthropic.api_key', value: '[redacted]' }));
  });

  it('rotates the master key: re-wraps data keys, and old-only configs stop working', async () => {
    const NEW_KEY = Buffer.alloc(32, 8).toString('base64');
    const rotating = localKeyProvider(NEW_KEY, [MASTER_KEY]);
    expect(await rewrapDataKeys(srv.db.admin, rotating)).toEqual({ rewrapped: 1 });
    expect(await rewrapDataKeys(srv.db.admin, rotating)).toEqual({ rewrapped: 0 });
    const { rows } = await srv.db.admin.query(`SELECT DISTINCT kek_id FROM data_keys`);
    expect(rows).toEqual([{ kek_id: rotating.id }]);

    const read = (kp: ReturnType<typeof localKeyProvider>) =>
      srv.db.withWorkspace(wsA, (tx) => readSecret(tx, wsA, 'llm.anthropic.api_key', kp));
    expect(await read(localKeyProvider(NEW_KEY))).toBe('sk-test-123');
    await expect(read(localKeyProvider(MASTER_KEY))).rejects.toThrow(/MASTER_KEY_PREVIOUS/);

    // Rotate back so the running server's key works again.
    await rewrapDataKeys(srv.db.admin, localKeyProvider(MASTER_KEY, [NEW_KEY]));
    expect(await read(localKeyProvider(MASTER_KEY))).toBe('sk-test-123');
  });
});

describe('members and invitations', () => {
  const invitee: User = { email: `invitee-${Date.now()}@Example.com`, cookie: '', id: '' };
  const signUp = async (u: User) => {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: u.email, password: PASSWORD, name: 'Invitee' }),
    });
    u.cookie = cookieOf(res);
    u.id = (await res.json()).user.id;
  };
  const accept = (u: User, token: string) =>
    fetch(`${BASE}/api/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u.cookie },
      body: JSON.stringify({ token }),
    });

  it('invites by e-mail with a one-time link that only the invited address can accept', async () => {
    const owner = api(users.owner);
    const inv = await owner.call('members.invite', { email: invitee.email, role: 'marketer' }, { idempotencyKey: 'invite-1' });
    expect(inv).toMatchObject({ email: invitee.email.toLowerCase(), role: 'marketer', status: 'pending' });
    expect(inv.acceptPath).toBe(`/invite#${inv.token}`);
    // The token is shown once: a replay returns it redacted, and only its hash is stored.
    expect(await owner.call('members.invite', { email: invitee.email, role: 'marketer' }, { idempotencyKey: 'invite-1' })).toMatchObject({
      id: inv.id,
      token: '[redacted]',
    });
    const { rows } = await srv.db.admin.query(`SELECT response::text FROM idempotency_keys`);
    expect(JSON.stringify(rows)).not.toContain(inv.token);
    expect((await rejects(owner.call('members.invite', { email: invitee.email, role: 'viewer' }))).status).toBe(409);
    expect((await rejects(owner.call('members.invite', { email: users.viewer.email, role: 'viewer' }))).status).toBe(409);

    expect((await accept({ ...invitee, cookie: '' }, inv.token)).status).toBe(401);
    expect((await accept(users.outsider, inv.token)).status).toBe(403);
    expect((await accept(users.outsider, 'not-a-token')).status).toBe(404);

    await signUp(invitee);
    const res = await accept(invitee, inv.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: wsA, role: 'marketer' });
    expect((await accept(invitee, inv.token)).status).toBe(404); // used up

    expect(await api(invitee).call('artifacts.create', note('From the new marketer'))).toMatchObject({ state: 'draft' });
    const { members } = await owner.call('members.list', {});
    expect(members.find((m) => m.userId === invitee.id)).toMatchObject({ email: invitee.email.toLowerCase(), role: 'marketer' });
    expect((await owner.call('invitations.list', {})).invitations[0]).toMatchObject({ id: inv.id, status: 'accepted' });
    const { entries } = await owner.call('audit.list', { limit: 5 });
    expect(entries.some((e) => e.command === 'invitations.accept' && e.principalId === invitee.id && e.ok)).toBe(true);
  });

  it('revokes invitations', async () => {
    const owner = api(users.owner);
    const inv = await owner.call('members.invite', { email: `later-${Date.now()}@example.com`, role: 'viewer' });
    await owner.call('invitations.revoke', { id: inv.id });
    expect((await accept(users.outsider, inv.token)).status).toBe(404);
    expect((await rejects(owner.call('invitations.revoke', { id: inv.id }))).status).toBe(404);
  });

  it('keeps owners in charge of owners, and never leaves a workspace without one', async () => {
    const owner = api(users.owner);
    await owner.call('members.setRole', { userId: invitee.id, role: 'admin' });
    const admin = api(invitee);
    expect((await rejects(admin.call('members.invite', { email: 'boss@example.com', role: 'owner' }))).status).toBe(403);
    expect((await rejects(admin.call('members.setRole', { userId: users.viewer.id, role: 'owner' }))).status).toBe(403);
    expect((await rejects(admin.call('members.remove', { userId: users.owner.id }))).status).toBe(403);
    expect((await rejects(api(users.viewer).call('members.list', {}))).status).toBe(403);

    expect((await rejects(owner.call('members.setRole', { userId: users.owner.id, role: 'admin' }))).status).toBe(409);
    expect((await rejects(owner.call('members.remove', { userId: users.owner.id }))).status).toBe(409);

    // With a second owner, the first can step down, and be reinstated.
    await owner.call('members.setRole', { userId: users.reviewer.id, role: 'owner' });
    await owner.call('members.setRole', { userId: users.owner.id, role: 'admin' });
    await api(users.reviewer).call('members.setRole', { userId: users.owner.id, role: 'owner' });
    await owner.call('members.setRole', { userId: users.reviewer.id, role: 'approver' });

    // A removed member loses access at once.
    await admin.call('members.remove', { userId: users.viewer.id });
    expect((await rejects(api(users.viewer).call('artifacts.list', {}))).status).toBe(401);
    expect((await rejects(admin.call('members.remove', { userId: users.viewer.id }))).status).toBe(404);
  });
});

describe('audit log and API description', () => {
  it('records both surfaces in a verifiable, append-only chain', async () => {
    const owner = api(users.owner);
    const { entries } = await owner.call('audit.list', { limit: 500 });
    expect(new Set(entries.map((e) => `${e.surface}:${e.principalType}`))).toEqual(new Set(['rest:user', 'mcp:agent']));
    expect(entries.some((e) => !e.ok && e.error?.startsWith('forbidden'))).toBe(true);
    expect(await owner.call('audit.verify', {})).toMatchObject({ ok: true, firstBrokenSeq: null });
    await expect(srv.db.app.query('UPDATE audit_log SET ok = true')).rejects.toThrow(/permission denied/);
  });

  it('documents every command in OpenAPI 3.1', async () => {
    const doc = await (await fetch(`${BASE}/openapi.json`)).json();
    const { commands } = await import('../src/registry');
    expect(Object.keys(doc.paths).sort()).toEqual(commands.map((c) => `/v1/${c.name}`).sort());
  });

  it('answers health checks', async () => {
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    expect((await fetch(`${BASE}/readyz`)).status).toBe(200);
  });
});
