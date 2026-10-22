import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, type User } from './harness';

// Phase 11 (wave 2), part a: enterprise identity. Single sign-on with an OIDC identity provider
// (a stand-in IdP that signs real ID tokens), SCIM provisioning by an identity provider, and MCP
// scope step-up for agents that need a permission they were not granted.

const PORT = 3292;
const BASE = `http://localhost:${PORT}`;
let idp: Server;
let idpBase = '';
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const keys = await generateKeyPair('RS256');
const codes = new Map<string, { nonce?: string; email: string }>();
let nextEmail = 'jo@acme.test';

beforeAll(async () => {
  idp = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idpBase);
    let raw = '';
    for await (const c of req) raw += c;
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: idpBase,
        authorization_endpoint: `${idpBase}/authorize`,
        token_endpoint: `${idpBase}/token`,
        userinfo_endpoint: `${idpBase}/userinfo`,
        jwks_uri: `${idpBase}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    if (url.pathname === '/jwks') return json({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/authorize') {
      const code = `code-${codes.size + 1}`;
      codes.set(code, { nonce: url.searchParams.get('nonce') ?? undefined, email: nextEmail });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === '/token') {
      const code = new URLSearchParams(raw).get('code')!;
      const c = codes.get(code)!;
      const idToken = await new SignJWT({ email: c.email, email_verified: true, name: 'Jo Acme', ...(c.nonce ? { nonce: c.nonce } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idpBase)
        .setAudience('agentic-marketing')
        .setSubject(`sub-${c.email}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return json({ access_token: `at-${code}`, id_token: idToken, token_type: 'Bearer', expires_in: 300 });
    }
    if (url.pathname === '/userinfo') return json({ sub: `sub-${nextEmail}`, email: nextEmail, email_verified: true, name: 'Jo Acme' });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  // An IdP on a private address must be trusted explicitly (as on a corporate network).
  t = await startTestServer('test_p11_identity', PORT, { TRUSTED_ORIGINS: idpBase });
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(async () => {
  await t?.close();
  idp?.close();
});

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
const json = (cookie: string) => ({ 'content-type': 'application/json', origin: BASE, cookie });

async function ssoSignIn(email: string) {
  nextEmail = email;
  const start = await fetch(`${BASE}/api/auth/sign-in/sso`, {
    method: 'POST',
    headers: json(''),
    body: JSON.stringify({ email, callbackURL: '/' }),
  });
  const { url } = await start.json();
  const authorize = await fetch(url, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { cookie: cookiesOf(start) } });
  return { status: callback.status, cookie: cookiesOf(callback) };
}

describe('single sign-on (OIDC)', () => {
  it('lets only owners and admins register a provider for their workspace', async () => {
    const viewer = await t.signUp(`viewer-${Date.now()}@example.com`);
    await t.srv.db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`, [ws, viewer.id]);
    const body = {
      providerId: 'acme',
      issuer: idpBase,
      domain: 'acme.test',
      workspaceId: ws,
      oidcConfig: { clientId: 'agentic-marketing', clientSecret: 's3cret', pkce: true },
    };
    expect(
      (await fetch(`${BASE}/api/auth/sso/register`, { method: 'POST', headers: json(viewer.cookie), body: JSON.stringify(body) })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${BASE}/api/auth/sso/register`, {
          method: 'POST',
          headers: json(owner.cookie),
          body: JSON.stringify({ ...body, defaultRole: 'owner' }),
        })
      ).status,
    ).toBe(400);
    const ok = await fetch(`${BASE}/api/auth/sso/register`, {
      method: 'POST',
      headers: json(owner.cookie),
      body: JSON.stringify({ ...body, defaultRole: 'marketer' }),
    });
    expect(ok.status).toBe(200);
    // Moving it to a workspace the admin does not run is refused.
    const move = await fetch(`${BASE}/api/auth/sso/update-provider`, {
      method: 'POST',
      headers: json(owner.cookie),
      body: JSON.stringify({ providerId: 'acme', workspaceId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(move.status).toBe(400);
    expect((await t.api(owner).call('sso.list', {})).providers).toEqual([
      {
        providerId: 'acme',
        type: 'oidc',
        issuer: idpBase,
        domain: 'acme.test',
        domainVerified: false,
        defaultRole: 'marketer',
        enforced: false,
      },
    ]);
  });

  it('signs a person in through the identity provider and makes them a member with the default role', async () => {
    // Domain verification is a DNS TXT record; here the database stands in for it.
    await t.srv.db.admin.query(`UPDATE "ssoProvider" SET "domainVerified" = true WHERE "providerId" = 'acme'`);
    const { status, cookie } = await ssoSignIn('jo@acme.test');
    expect(status).toBe(302);
    // The session works, and the workspace has a new marketer.
    const jo: User = { email: 'jo@acme.test', cookie, id: '' };
    expect(await t.api(jo).call('artifacts.list', {})).toMatchObject({ artifacts: [] });
    const members = await t.api(owner).call('members.list', {});
    expect(members.members.find((m) => m.email === 'jo@acme.test')?.role).toBe('marketer');
  });

  it('turns off passwords for the domain when the provider is enforced', async () => {
    await t.srv.db.admin.query(`UPDATE "ssoProvider" SET enforced = true WHERE "providerId" = 'acme'`);
    const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: json(''),
      body: JSON.stringify({ email: 'new@acme.test', password: 'correct horse battery', name: 'New' }),
    });
    expect(signUp.status).toBe(403);
    expect((await signUp.json()).message).toContain('single sign-on');
  });
});

describe('SCIM provisioning', () => {
  let token = '';
  const scim = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}/scim/v2${path}`, {
      ...init,
      headers: { 'content-type': 'application/scim+json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  it('creates, groups, deactivates and removes people, with roles from groups', async () => {
    const api = t.api(owner);
    token = (await api.call('scim.rotateToken', {})).token;
    expect((await scim('/Users', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    await api.call('scim.configure', { defaultRole: 'viewer', groupRoles: { 'Marketing Admins': 'admin' } });

    const created = await scim('/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'sam@acme.test',
        name: { givenName: 'Sam', familyName: 'Lee' },
        externalId: 'okta-1',
        active: true,
      }),
    });
    expect(created.status).toBe(201);
    const sam = await created.json();
    expect(sam).toMatchObject({ userName: 'sam@acme.test', externalId: 'okta-1', active: true, displayName: 'Sam Lee' });
    const found = await (await scim(`/Users?filter=${encodeURIComponent('userName eq "SAM@acme.test"')}`)).json();
    expect(found.totalResults).toBe(1);
    const roleOf = async (email: string) => (await api.call('members.list', {})).members.find((m) => m.email === email)?.role;
    expect(await roleOf('sam@acme.test')).toBe('viewer');

    const group = await (
      await scim('/Groups', { method: 'POST', body: JSON.stringify({ displayName: 'Marketing Admins', members: [{ value: sam.id }] }) })
    ).json();
    expect(await roleOf('sam@acme.test')).toBe('admin');
    await scim(`/Groups/${group.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: `members[value eq "${sam.id}"]` }],
      }),
    });
    expect(await roleOf('sam@acme.test')).toBe('viewer');

    // Entra ID style: deactivate with a path-less replace.
    const off = await scim(`/Users/${sam.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'Replace', value: { active: false } }],
      }),
    });
    expect((await off.json()).active).toBe(false);
    expect(await roleOf('sam@acme.test')).toBeUndefined();

    // Owners are left to people.
    const ownerRow = (await (await scim(`/Users?filter=${encodeURIComponent(`userName eq "${owner.email.toLowerCase()}"`)}`)).json())
      .Resources[0];
    expect((await scim(`/Users/${ownerRow.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await scim(`/Users/${sam.id}`, { method: 'DELETE' })).status).toBe(204);

    const audit = await api.call('audit.list', { limit: 50 });
    expect(audit.entries.filter((e) => e.surface === 'scim').map((e) => e.command)).toEqual(
      expect.arrayContaining(['scim.upsertUser', 'scim.upsertGroup', 'scim.deleteUser']),
    );
  });

  it('stops SSO from adding members on its own while SCIM is on', async () => {
    const { cookie } = await ssoSignIn('kim@acme.test');
    expect(cookie).toContain('session_token');
    expect((await t.api(owner).call('members.list', {})).members.some((m) => m.email === 'kim@acme.test')).toBe(false);
  });
});

describe('MCP scope step-up', () => {
  it('lists tools the role allows, and answers a call without the scope with insufficient_scope', async () => {
    const agent = await connectAgent(BASE, owner, ['artifacts:read']);
    const tools = (await agent.client.listTools()).tools;
    const create = tools.find((x) => x.name === 'artifacts.create');
    expect(create?.description).toContain('Needs the "artifacts:write" permission');
    expect(tools.some((x) => x.name === 'members.invite')).toBe(false); // people only, never offered

    const accessToken = (agent.provider.tokens() as { access_token: string }).access_token;
    const call = (name: string, args: unknown) =>
      fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
    const denied = await call('artifacts.create', { type: 'note', name: 'x', content: { title: 'x', body: 'x' } });
    expect(denied.status).toBe(403);
    const challenge = denied.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toMatch(/scope="[^"]*artifacts:read[^"]*artifacts:write|scope="[^"]*artifacts:write[^"]*artifacts:read/);
    expect(challenge).toContain('resource_metadata="');
    expect((await call('artifacts.list', {})).status).toBe(200);
    await agent.client.close();
  });
});
