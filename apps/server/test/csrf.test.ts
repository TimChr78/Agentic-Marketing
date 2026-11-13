import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// A session cookie rides on a cross-site request whatever the content type. A write that would be
// allowed for the person must still prove it came from the app: JSON only (an HTML form cannot send
// it), and an Origin that matches the app or a trusted origin. Bearer tokens are not attached by a
// browser and stay usable without an Origin. Better Auth's own /api/auth/* routes are out of scope
// and already validate Origin against the same trusted list.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let viewer: User;
let ws = '';

const postJson = (base: string, path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const roleOf = async (user: User) =>
  (await t.api(owner, ws).call('members.list', {})).members.find((member) => member.userId === user.id)?.role;

beforeAll(async () => {
  t = await startTestServer('csrf', testPort(2505));
  owner = await t.signUp(`csrf-owner-${Date.now()}@example.com`);
  viewer = await t.signUp(`csrf-viewer-${Date.now()}@example.com`);
  ws = await t.workspaceWith([
    [owner, 'owner'],
    [viewer, 'viewer'],
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('CSRF on cookie-authenticated writes (#838)', () => {
  it('refuses text/plain, so a form cannot forge a privileged mutation', async () => {
    const res = await fetch(`${t.base}/v1/members.setRole`, {
      method: 'POST',
      headers: {
        // A simple request an HTML form or a cross-site fetch sends without a preflight.
        'content-type': 'text/plain',
        origin: 'https://evil.example',
        cookie: owner.cookie,
        'x-workspace-id': ws,
      },
      body: JSON.stringify({ userId: viewer.id, role: 'owner' }),
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('unsupported_media_type');
    expect(await roleOf(viewer)).toBe('viewer');
  });

  it('refuses a JSON write from another origin', async () => {
    const res = await postJson(
      t.base,
      '/v1/members.setRole',
      { origin: 'https://evil.example', cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'owner' },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(await roleOf(viewer)).toBe('viewer');
  });

  it('refuses Origin: null and an origin that only prefix-matches the app', async () => {
    const nullOrigin = await postJson(t.base, '/v1/workspace.get', { origin: 'null', cookie: owner.cookie, 'x-workspace-id': ws }, {});
    expect(nullOrigin.status).toBe(403);
    const prefixed = await postJson(
      t.base,
      '/v1/workspace.get',
      { origin: `${t.base}.evil.example`, cookie: owner.cookie, 'x-workspace-id': ws },
      {},
    );
    expect(prefixed.status).toBe(403);
  });

  it('requires Sec-Fetch-Site: same-origin when Origin is absent, and refuses same-site', async () => {
    const absent = await postJson(
      t.base,
      '/v1/members.setRole',
      { cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'owner' },
    );
    expect(absent.status).toBe(403);
    const sameSite = await postJson(
      t.base,
      '/v1/members.setRole',
      { 'sec-fetch-site': 'same-site', cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'owner' },
    );
    expect(sameSite.status).toBe(403);
    expect(await roleOf(viewer)).toBe('viewer');
  });

  it('does not let a method-override header skip the body-type check', async () => {
    const res = await fetch(`${t.base}/v1/members.setRole`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-http-method-override': 'GET',
        origin: 'https://evil.example',
        cookie: owner.cookie,
        'x-workspace-id': ws,
      },
      body: JSON.stringify({ userId: viewer.id, role: 'owner' }),
    });
    expect(res.status).toBe(415);
    expect(await roleOf(viewer)).toBe('viewer');
  });

  it('allows a JSON write from the app origin, and falls back to Sec-Fetch-Site when Origin is absent', async () => {
    const allowed = await postJson(
      t.base,
      '/v1/members.setRole',
      { origin: t.base, cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'approver' },
    );
    expect(allowed.status).toBe(200);

    const fallback = await postJson(
      t.base,
      '/v1/members.setRole',
      { 'sec-fetch-site': 'same-origin', cookie: owner.cookie, 'x-workspace-id': ws },
      { userId: viewer.id, role: 'viewer' },
    );
    expect(fallback.status).toBe(200);
  });

  it('allows a bearer token without an Origin: a page cannot attach it', async () => {
    const created = await t.api(owner, ws).call('apiTokens.create', { name: 'CSRF probe', scopes: ['artifacts:read'] });
    const res = await fetch(`${t.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('refuses a form post to the invitation endpoint from another origin, and accepts one from the app', async () => {
    const invitee = await t.signUp(`csrf-invitee-${Date.now()}@example.com`);
    const invite = await t.api(owner, ws).call('members.invite', { email: invitee.email, role: 'viewer' });

    const refused = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        cookie: invitee.cookie,
      },
      body: new URLSearchParams({ token: invite.token }).toString(),
    });
    expect(refused.status).toBe(403);

    const accepted = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: t.base,
        cookie: invitee.cookie,
      },
      body: new URLSearchParams({ token: invite.token }).toString(),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ workspaceId: ws, role: 'viewer' });
  });

  it('refuses a form post to the consent workspace endpoint from another origin, and accepts one from the app', async () => {
    const body = (workspaceId: string) =>
      new URLSearchParams({ workspaceId, oauthQuery: 'client_id=csrf-probe&state=csrf-state&response_type=code' }).toString();
    const refused = await fetch(`${t.base}/api/oauth/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', cookie: owner.cookie },
      body: body(ws),
    });
    expect(refused.status).toBe(403);

    const accepted = await fetch(`${t.base}/api/oauth/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.base, cookie: owner.cookie },
      body: body(ws),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ workspaceId: ws });
  });

  it('refuses a form content type on the copilot endpoint', async () => {
    const res = await fetch(`${t.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', cookie: owner.cookie },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(415);
  });

  it('trusts an exact TRUSTED_ORIGINS entry, not a sibling or a prefix look-alike', async () => {
    const trusted = 'https://app.example.test';
    const other = await startTestServer('csrf_trusted', testPort(2509), { TRUSTED_ORIGINS: trusted });
    try {
      const user = await other.signUp(`csrf-trusted-${Date.now()}@example.com`);
      const workspaceId = await other.workspaceWith([[user, 'owner']]);
      const call = (origin: string) =>
        postJson(other.base, '/v1/workspace.get', { origin, cookie: user.cookie, 'x-workspace-id': workspaceId }, {});

      expect((await call(trusted)).status).toBe(200);
      // A sibling subdomain and an origin that merely starts with the trusted one are both refused.
      expect((await call('https://evil.example.test')).status).toBe(403);
      expect((await call('https://app.example.test.evil.example')).status).toBe(403);
    } finally {
      await other.close();
    }
  });
});
