import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// PR #1277 review: single sign-on must not pre-empt an invitation (the invited role wins, and an
// existing role is never lowered), and the OAuth flow must resume after SSO instead of replaying
// the already-satisfied `prompt=login` back to the sign-in page.

const PORT = testPort(4492);
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
      const idToken = await new SignJWT({
        email: c.email,
        email_verified: true,
        name: 'Jo Acme',
        ...(c.nonce ? { nonce: c.nonce } : {}),
      })
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
  t = await startTestServer('test_sso_round_trip', PORT, { TRUSTED_ORIGINS: idpBase });
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  const registered = await fetch(`${BASE}/api/auth/sso/register`, {
    method: 'POST',
    headers: json(owner.cookie),
    body: JSON.stringify({
      providerId: 'acme',
      issuer: idpBase,
      domain: 'acme.test',
      workspaceId: ws,
      oidcConfig: { clientId: 'agentic-marketing', clientSecret: 's3cret', pkce: true },
      defaultRole: 'marketer',
    }),
  });
  if (registered.status !== 200) throw new Error(`SSO provider registration returned ${registered.status}: ${await registered.text()}`);
  // Domain verification is a DNS TXT record; here the database stands in for it.
  await t.srv.db.admin.query(`UPDATE "ssoProvider" SET "domainVerified" = true WHERE "providerId" = 'acme'`);
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

async function ssoSignIn(email: string, callbackURL: string) {
  nextEmail = email;
  const start = await fetch(`${BASE}/api/auth/sign-in/sso`, {
    method: 'POST',
    headers: json(''),
    body: JSON.stringify({ email, callbackURL }),
  });
  expect(start.status).toBe(200);
  const { url } = await start.json();
  const authorize = await fetch(url, { redirect: 'manual' });
  return fetch(authorize.headers.get('location')!, {
    redirect: 'manual',
    headers: { cookie: cookiesOf(start) },
  });
}

describe('SSO and invitations (#1277 review)', () => {
  it('accepts an invitation to the workspace that owns the SSO provider with the invited role', async () => {
    const email = 'invited@acme.test';
    const invitation = await t.api(owner).call('members.invite', { email, role: 'approver' });
    const callback = await ssoSignIn(email, invitation.acceptPath);
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get('location')!, BASE).pathname).toBe('/invite');
    const accept = await fetch(`${BASE}/api/invitations/accept`, {
      method: 'POST',
      headers: json(cookiesOf(callback)),
      body: JSON.stringify({ token: invitation.token }),
    });
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ role: 'approver' });
  });

  it('never lowers an existing member’s role when an invitation is accepted', async () => {
    const email = 'existing-admin@acme.test';
    const invitation = await t.api(owner).call('members.invite', { email, role: 'viewer' });
    // The person joins another way before accepting (for example a directory sync).
    const existing = await t.signUp(email);
    await t.srv.db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [ws, existing.id]);

    const accept = await fetch(`${BASE}/api/invitations/accept`, {
      method: 'POST',
      headers: json(existing.cookie),
      body: JSON.stringify({ token: invitation.token }),
    });
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ role: 'admin' });
    const { rows } = await t.srv.db.admin.query(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
      ws,
      existing.id,
    ]);
    expect(rows[0].role).toBe('admin');
  });
});

describe('OAuth authorization resumes after SSO (#1277 review)', () => {
  it('removes the satisfied prompt=login and reaches consent', async () => {
    const metadata = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    const redirectURI = 'https://review-app.example.com/callback';
    const register = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: json(''),
      body: JSON.stringify({
        client_name: 'SSO review',
        redirect_uris: [redirectURI],
        scope: 'artifacts:read',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (register.status !== 201) throw new Error(`Registration returned ${register.status}: ${await register.text()}`);
    const client = await register.json();
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectURI,
      response_type: 'code',
      scope: 'artifacts:read',
      resource: `${BASE}/mcp`,
      prompt: 'login',
      state: 'review-state',
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const navigation = { redirect: 'manual' as const, headers: { accept: 'application/json' } };
    const login = await fetch(authorize, navigation);
    const loginBody = login.headers.has('location') ? null : await login.json();
    const loginLocation = login.headers.get('location') ?? loginBody?.url;
    if (!loginLocation) throw new Error(`Authorization returned ${login.status}: ${JSON.stringify(loginBody)}`);
    const loginUrl = new URL(loginLocation, BASE);
    expect(loginUrl.pathname).toBe('/login');

    const callback = await ssoSignIn('jo@acme.test', authorize.pathname + loginUrl.search);
    expect(callback.status).toBe(302);
    const callbackLocation = callback.headers.get('location')!;
    // The callback URL must not still ask for a login prompt, or the client loops back here.
    expect(new URL(callbackLocation, BASE).searchParams.get('prompt')).not.toBe('login');
    expect(new URL(callbackLocation, BASE).searchParams.get('state')).toBe('review-state');

    const resumed = await fetch(new URL(callbackLocation, BASE), {
      ...navigation,
      headers: { ...navigation.headers, cookie: cookiesOf(callback) },
    });
    const resumedBody = resumed.headers.has('location') ? null : await resumed.json();
    const resumedLocation = resumed.headers.get('location') ?? resumedBody?.url;
    if (!resumedLocation) throw new Error(`OAuth resume returned ${resumed.status}: ${JSON.stringify(resumedBody)}`);
    expect(new URL(resumedLocation, BASE).pathname).toBe('/consent');
  });
});
