import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';

// End-to-end: one Postgres, one server, three surfaces. Run with a local Postgres (see FINDINGS.md).
const PORT = 3199;
process.env.PORT = String(PORT);
const BASE = `http://localhost:${PORT}`;

const mods = async () => {
  const [{ createApp }, { migrate }, pool, client, registry, cmds] = await Promise.all([
    import('../src/app'),
    import('../src/db/migrate'),
    import('../src/db/pool'),
    import('../src/surfaces/client'),
    import('../src/registry'),
    import('../src/commands'),
  ]);
  return { createApp, migrate, ...pool, ...client, ...registry, ...cmds };
};
let m: Awaited<ReturnType<typeof mods>>;
let server: { close: () => void };

const wsA = randomUUID();
const wsB = randomUUID();
const users = {
  tim: { email: `tim+${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'Tim', cookie: '', id: '' },
  other: { email: `other+${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'Other', cookie: '', id: '' },
};

function cookieFrom(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function signUp(u: (typeof users)['tim']) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: u.email, password: u.password, name: u.name }),
  });
  expect(res.status).toBe(200);
  u.cookie = cookieFrom(res);
  u.id = (await res.json()).user.id;
}

type JourneyInput = import('../src/surfaces/client').CommandInput<'journeys.createDraft'>;
const journey = (id: string): JourneyInput => ({
  id,
  name: 'Win-back 60 days',
  purpose: 'marketing_email',
  goal: 'Order within 14 days',
  nodes: [
    { id: 'n1', kind: 'trigger', label: 'Entered lapsed segment', config: { event: 'segment.entered' } },
    { id: 'n2', kind: 'email', label: 'We miss you', config: { template: 'tpl_win_back' } },
    { id: 'n3', kind: 'goal', label: 'Ordered', config: { event: 'order_completed', within: 'P14D' } },
  ],
});

/** In-memory OAuth client for the MCP SDK; the "browser" part is done by `consentHeadless`. */
class TestOAuthProvider implements OAuthClientProvider {
  info: any;
  tokenSet: any;
  verifier = '';
  authorizationUrl?: URL;
  constructor(private scope: string) {}
  get redirectUrl() {
    return 'http://localhost/callback';
  }
  get clientMetadata() {
    return {
      client_name: 'Spike test agent',
      redirect_uris: ['http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.scope,
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: unknown) {
    this.info = i;
  }
  tokens() {
    return this.tokenSet;
  }
  saveTokens(t: unknown) {
    this.tokenSet = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  discovery: any;
  saveDiscoveryState(s: unknown) {
    this.discovery = s;
  }
  discoveryState() {
    return this.discovery;
  }
}

/** Plays the user in the browser: follow /authorize → sign in → consent → return the code. */
async function consentHeadless(authorizationUrl: URL, u: (typeof users)['tim'], grant?: string) {
  // Better Auth answers a 302 to browsers and a JSON redirect to fetch clients.
  const authz = await fetch(authorizationUrl, { redirect: 'manual', headers: { accept: 'application/json' } });
  const login = new URL(authz.headers.get('location') ?? (await authz.json()).url, BASE);
  expect(login.pathname).toBe('/login');
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: u.email, password: u.password, oauth_query: login.search.slice(1) }),
  });
  const cookie = cookieFrom(signIn);
  let next = new URL((await signIn.json()).url, BASE);
  if (next.pathname === '/consent') {
    const consent = await fetch(`${BASE}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie },
      body: JSON.stringify({ accept: true, oauth_query: next.search.slice(1), ...(grant ? { scope: grant } : {}) }),
    });
    next = new URL((await consent.json()).url);
  }
  const code = next.searchParams.get('code');
  expect(code, `no code in ${next}`).toBeTruthy();
  return next.searchParams; // includes `iss` (RFC 9207), which the SDK verifies
}

async function connectAgent(scope: string, grant?: string, u = users.tim) {
  const provider = new TestOAuthProvider(scope);
  const first = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider });
  const c1 = new Client({ name: 'spike-test', version: '0.0.0' });
  await expect(c1.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  const callback = await consentHeadless(provider.authorizationUrl!, u, grant);
  await first.finishAuth(callback);
  const client = new Client({ name: 'spike-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider }));
  return { client, provider };
}

beforeAll(async () => {
  m = await mods();
  await m.migrate();
  const { serve } = await import('@hono/node-server');
  await new Promise<void>((resolve) => {
    server = serve({ fetch: m.createApp().fetch, port: PORT }, (info: AddressInfo) => {
      expect(info.port).toBe(PORT);
      resolve();
    });
  });
  await signUp(users.tim);
  await signUp(users.other);
  await m.adminPool.query(`INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Fjeldvej', 'agent_changes'), ($2, 'Other shop', 'none')`, [wsA, wsB]);
  await m.adminPool.query(`INSERT INTO workspace_members VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`, [wsA, users.tim.id, wsB, users.other.id]);
}, 60_000);

afterAll(async () => {
  server?.close();
  await m.closePools();
});

describe('REST surface + typed client', () => {
  it('creates, reads and lists a journey draft with full types', async () => {
    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const created = await api.call('journeys.createDraft', journey('jrn_rest'));
    expect(created).toEqual({ journeyId: 'jrn_rest', version: 1, state: 'draft' });
    const got = await api.call('journeys.get', { journeyId: 'jrn_rest' });
    expect(got.version.author).toEqual({ type: 'user', id: users.tim.id, client: null });
    const list = await api.call('journeys.list', {});
    expect(list.journeys.map((j) => j.id)).toContain('jrn_rest');
  });

  it('returns the same structured validation error the registry produces', async () => {
    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const bad: JourneyInput = { ...journey('jrn_bad'), nodes: [{ id: 'n1', kind: 'email', label: 'No trigger', config: {}, next: [{ to: 'nope' }] }] };
    const err = await api.call('journeys.createDraft', bad).catch((e) => e);
    expect(err).toBeInstanceOf(m.ApiError);
    expect(err.status).toBe(400);
    expect(JSON.stringify(err.details)).toContain('unknown node');
    expect(JSON.stringify(err.details)).toContain('exactly one trigger');
  });

  it('honours idempotency keys', async () => {
    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const a = await api.call('journeys.createDraft', journey('jrn_idem'), { idempotencyKey: 'k-1' });
    const b = await api.call('journeys.createDraft', journey('jrn_idem'), { idempotencyKey: 'k-1' });
    expect(b).toEqual(a);
    const conflict = await api.call('journeys.createDraft', journey('jrn_idem2'), { idempotencyKey: 'k-1' }).catch((e) => e);
    expect(conflict.status).toBe(409);
  });

  it('isolates workspaces with row-level security, even for a query without a workspace filter', async () => {
    const other = m.createClient(BASE, { headers: { cookie: users.other.cookie } });
    const list = await other.call('journeys.list', {});
    expect(list.journeys).toEqual([]);
    const err = await other.call('journeys.get', { journeyId: 'jrn_rest' }).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it('publishes a human-authored draft directly under the "agent_changes" policy', async () => {
    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const res = await api.call('journeys.requestPublish', { journeyId: 'jrn_rest', note: 'Ship it' });
    expect(res).toMatchObject({ status: 'published', version: 1 });
  });

  it('documents every command in OpenAPI 3.1', async () => {
    const doc = await (await fetch(`${BASE}/openapi.json`)).json();
    expect(Object.keys(doc.paths).sort()).toEqual(m.commands.map((c) => `/v1/${c.name}`).sort());
    expect(doc.paths['/v1/journeys.createDraft'].post.requestBody.content['application/json'].schema.properties.nodes).toBeTruthy();
  });
});

describe('MCP surface with OAuth 2.1 (dynamic client registration + PKCE)', () => {
  let agent: Awaited<ReturnType<typeof connectAgent>>;

  beforeAll(async () => {
    agent = await connectAgent('openid offline_access journeys:read journeys:write journeys:publish audit:read');
  }, 30_000);
  afterAll(() => agent?.client.close());

  it('lists tools generated from the registry, without humans-only commands', async () => {
    const { tools } = await agent.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(m.commands.filter((c) => !c.humansOnly).map((c) => c.name).sort());
    const list = tools.find((t) => t.name === 'journeys.list')!;
    expect(list.annotations?.readOnlyHint).toBe(true);
    const create = tools.find((t) => t.name === 'journeys.createDraft')!;
    expect((create.inputSchema as any).properties.nodes.type).toBe('array');
    expect(create.outputSchema).toBeTruthy();
  });

  it('runs commands as an agent principal, and agent changes need a human to approve', async () => {
    const created = await agent.client.callTool({ name: 'journeys.createDraft', arguments: journey('jrn_agent') });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toEqual({ journeyId: 'jrn_agent', version: 1, state: 'draft' });

    const pub = await agent.client.callTool({ name: 'journeys.requestPublish', arguments: { journeyId: 'jrn_agent', note: 'Proposed by agent' } });
    expect(pub.structuredContent).toMatchObject({ status: 'in_review', policy: 'agent_changes' });

    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const got = await api.call('journeys.get', { journeyId: 'jrn_agent' });
    expect(got.version.author.type).toBe('agent');
    expect(got.version.author.client).toBe(agent.provider.info.client_id);

    expect(await api.call('journeys.approve', { journeyId: 'jrn_agent', version: 1 })).toEqual({ status: 'published', version: 1 });
  });

  it('refuses humans-only commands for agents even when called directly', async () => {
    const approve = m.commandByName.get('journeys.approve')!;
    const principal = { type: 'agent' as const, userId: users.tim.id, clientId: 'x', workspaceId: wsA, scopes: new Set(['journeys:publish']) };
    await expect(m.execute(approve, { journeyId: 'jrn_agent', version: 1 }, principal, { surface: 'internal' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('returns tool errors as structured MCP errors', async () => {
    const res = await agent.client.callTool({ name: 'journeys.get', arguments: { journeyId: 'jrn_missing' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as any)[0].text)).toMatchObject({ error: 'not_found' });
  });

  it('limits an agent to the scopes the user granted on the consent screen', async () => {
    // The SDK asks for every advertised scope; the user narrows it to read-only when consenting.
    const readOnly = await connectAgent('openid journeys:read', 'journeys:read offline_access');
    try {
      const res = await readOnly.client.callTool({ name: 'journeys.createDraft', arguments: journey('jrn_ro') });
      expect(res.isError).toBe(true);
      expect(JSON.parse((res.content as any)[0].text)).toMatchObject({ error: 'forbidden', message: 'Missing permission journeys:write' });
    } finally {
      await readOnly.client.close();
    }
  }, 30_000);
});

describe('audit log', () => {
  it('records every command from every surface in a verifiable hash chain', async () => {
    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const { entries } = await api.call('audit.list', { limit: 200 });
    const surfaces = new Set(entries.map((e) => `${e.surface}:${e.principalType}`));
    expect(surfaces).toEqual(new Set(['rest:user', 'mcp:agent', 'internal:agent']));
    expect(entries.some((e) => !e.ok && e.error?.startsWith('invalid_input'))).toBe(true);

    // Recompute the chain from the raw rows (admin role, oldest first).
    const { rows } = await m.adminPool.query('SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY seq', [wsA]);
    const canonical = (v: unknown): string =>
      Array.isArray(v)
        ? `[${v.map(canonical).join(',')}]`
        : v && typeof v === 'object'
          ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
          : JSON.stringify(v);
    let prev: string | null = null;
    for (const r of rows) {
      const entry = {
        workspaceId: r.workspace_id, principalType: r.principal_type, principalId: r.principal_id, clientId: r.client_id, surface: r.surface,
        command: r.command, effect: r.effect, inputHash: r.input_hash, ok: r.ok, error: r.error, prevHash: r.prev_hash,
      };
      expect(r.prev_hash).toBe(prev);
      expect(r.hash).toBe(createHash('sha256').update(canonical(entry)).digest('hex'));
      prev = r.hash;
    }
  });

  it('cannot be modified by the application role', async () => {
    await expect(m.appPool.query(`UPDATE audit_log SET ok = true`)).rejects.toThrow(/permission denied/);
  });
});

describe('latency (informational)', () => {
  it('measures a read command through REST and through MCP', async () => {
    const api = m.createClient(BASE, { headers: { cookie: users.tim.cookie } });
    const agent = await connectAgent('openid journeys:read', 'journeys:read');
    const time = async (fn: () => Promise<unknown>, n = 100) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        await fn();
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      return { p50: +ms[n / 2].toFixed(1), p95: +ms[Math.floor(n * 0.95)].toFixed(1) };
    };
    const rest = await time(() => api.call('journeys.list', {}));
    const mcp = await time(() => agent.client.callTool({ name: 'journeys.list', arguments: {} }));
    await agent.client.close();
    console.log('latency ms (local, sequential, incl. auth + audit write):', JSON.stringify({ rest, mcp }));
    expect(rest.p50).toBeLessThan(200);
    expect(mcp.p50).toBeLessThan(200);
  }, 60_000);
});
