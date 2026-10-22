import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { refreshConnection } from '@agentic-marketing/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Phase 8 (wave 2): consent everywhere. The banner's purposes, ad click ids kept only with
// ad_measurement, bot filtering, OAuth 2.0 connections with token refresh, shared rate limits.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let browserKey = '';
const SITE = 'https://martechsignal.com';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

// A stand-in OAuth 2.0 provider with one API endpoint.
const provider = {
  code: 'code-1',
  challenge: '',
  access: 'at-1',
  refresh: 'rt-1',
  refuseRefresh: false,
  tokenCalls: [] as Record<string, string>[],
};
let providerUrl = '';
const oauthServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.url === '/token') {
      const p = Object.fromEntries(new URLSearchParams(body));
      provider.tokenCalls.push(p);
      if (p.client_id !== 'client-1' || p.client_secret !== 'secret-1') return json(401, { error: 'invalid_client' });
      if (p.grant_type === 'authorization_code') {
        const ok = p.code === provider.code && createHash('sha256').update(p.code_verifier).digest('base64url') === provider.challenge;
        return ok
          ? json(200, { access_token: provider.access, refresh_token: provider.refresh, expires_in: 60, token_type: 'Bearer' })
          : json(400, { error: 'invalid_grant' });
      }
      if (p.grant_type === 'refresh_token') {
        if (provider.refuseRefresh || p.refresh_token !== provider.refresh)
          return json(400, { error: 'invalid_grant', error_description: 'Token has been revoked' });
        provider.access = 'at-2';
        return json(200, { access_token: provider.access, expires_in: 3600 });
      }
    }
    if (req.url === '/api/me')
      return req.headers.authorization === `Bearer ${provider.access}` ? json(200, { user: 'tim' }) : json(401, { error: 'unauthorized' });
    json(404, {});
  });
});

const ingest = (batch: unknown[], ua = BROWSER_UA) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: SITE,
      'user-agent': ua,
      authorization: `Basic ${Buffer.from(`${browserKey}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch }),
  });
const consent = (c: Record<string, boolean>) => ({ consent: { categoryPreferences: c } });
const clickIdsOf = async (type: 'anonymous_id' | 'email', value: string) => {
  const api = t.api(owner);
  const { profileId } = await eventually(
    () => api.call('profiles.find', { type, value }),
    (r) => !!r.profileId,
  );
  return (await api.call('profiles.get', { profileId: profileId! })).identifiers.filter(
    (i) => !['anonymous_id', 'user_id', 'email', 'phone'].includes(i.type),
  );
};

beforeAll(async () => {
  await new Promise<void>((r) => oauthServer.listen(0, '127.0.0.1', r));
  providerUrl = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`;
  t = await startTestServer('test_p8', 3290);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  browserKey = (await t.api(owner).call('sources.create', { name: 'Site', kind: 'browser', allowedOrigins: [SITE] })).key;
}, 60_000);
afterAll(async () => {
  await t?.close();
  oauthServer.close();
});

describe('consent banner support', () => {
  it('serves the purposes for the web to the site', async () => {
    const res = await fetch(`${t.base}/v1/consent/purposes?writeKey=${browserKey}`, { headers: { origin: SITE } });
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    const { purposes } = await res.json();
    expect(purposes.map((p: { key: string }) => p.key)).toEqual([
      'necessary',
      'analytics',
      'web_personalization',
      'ad_measurement',
      'ad_targeting',
    ]);
    expect(
      (await fetch(`${t.base}/v1/consent/purposes?writeKey=${browserKey}`, { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
  });

  it('drops bots on browser sources', async () => {
    const res = await ingest(
      [{ type: 'page', anonymousId: 'bot-1', context: consent({ analytics: true }) }],
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    );
    expect(await res.json()).toMatchObject({ success: true, accepted: 0, dropped: 1 });
  });
});

describe('ad click ids', () => {
  it('keeps click ids with ad_measurement allowed, and not without', async () => {
    await ingest([
      {
        type: 'page',
        anonymousId: 'anon-yes',
        context: { ...consent({ analytics: true, ad_measurement: true }), clickIds: { gclid: 'Cj0KCQjw-yes' } },
      },
      {
        type: 'page',
        anonymousId: 'anon-no',
        context: { ...consent({ analytics: true, ad_measurement: false }), page: { url: `${SITE}/?gclid=Cj0KCQjw-no`, path: '/' } },
      },
    ]);
    expect(
      await eventually(
        () => clickIdsOf('anonymous_id', 'anon-yes'),
        (ids) => ids.length > 0,
      ),
    ).toMatchObject([{ type: 'gclid', value: 'Cj0KCQjw-yes' }]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await clickIdsOf('anonymous_id', 'anon-no')).toEqual([]);
  });

  it('reads them from the landing URL', async () => {
    await ingest([
      {
        type: 'page',
        anonymousId: 'anon-url',
        context: {
          ...consent({ analytics: true, ad_measurement: true }),
          page: { url: `${SITE}/?msclkid=abc123def&utm_source=bing`, path: '/' },
        },
      },
    ]);
    expect(
      await eventually(
        () => clickIdsOf('anonymous_id', 'anon-url'),
        (ids) => ids.length > 0,
      ),
    ).toMatchObject([{ type: 'msclkid', value: 'abc123def' }]);
  });

  it('takes them from signup form fields with the banner choice', async () => {
    const api = t.api(owner);
    const form = await api.call('artifacts.create', {
      type: 'form',
      name: 'Newsletter',
      content: {
        purposes: ['marketing_email'],
        doubleOptIn: false,
        consentText: 'Yes please.',
        successUrl: '/thanks',
        confirmedUrl: '/welcome',
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: form.artifactId, note: 'x' });
    const post = (fields: Record<string, string>) =>
      fetch(`${t.base}/f/${form.artifactId}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    await post({ email: 'ada@example.com', fbclid: 'IwAR0abc', am_consent: 'analytics,ad_measurement' });
    await post({ email: 'bo@example.com', fbclid: 'IwAR0def' });
    const ada = await eventually(
      () => clickIdsOf('email', 'ada@example.com'),
      (ids) => ids.length > 0,
    );
    expect(ada[0].type).toBe('fbc');
    expect(ada[0].value).toMatch(/^fb\.1\.\d{13}\.IwAR0abc$/);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await clickIdsOf('email', 'bo@example.com')).toEqual([]);
  });
});

describe('OAuth 2.0 connections', () => {
  let id = '';

  it('connects with the authorization code flow and PKCE, and calls the API with the token', async () => {
    const api = t.api(owner);
    const con = await api.call('connections.create', {
      connector: 'oauth_http',
      name: 'Ads API',
      settings: {
        baseUrl: `${providerUrl}/api`,
        authorizeUrl: `${providerUrl}/authorize`,
        tokenUrl: `${providerUrl}/token`,
        scopes: ['ads.read'],
      },
      secrets: { clientId: 'client-1', clientSecret: 'secret-1' },
    });
    id = con.id;
    expect((await rejects(api.call('connections.runAction', { id, action: 'request', input: { path: 'me' } }))).message).toContain(
      'not connected',
    );

    const { url, redirectUri } = await api.call('connections.authorize', { id });
    expect(redirectUri).toBe(`${t.base}/oauth/callback`);
    const q = new URL(url).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      scope: 'ads.read',
      code_challenge_method: 'S256',
    });
    provider.challenge = q.get('code_challenge')!;

    const forged = await fetch(`${t.base}/oauth/callback?code=${provider.code}&state=forged`);
    expect(forged.status).toBe(400);
    const back = await fetch(`${t.base}/oauth/callback?code=${provider.code}&state=${q.get('state')}`);
    expect(await back.text()).toContain('is connected');
    const replay = await fetch(`${t.base}/oauth/callback?code=${provider.code}&state=${q.get('state')}`);
    expect(replay.status).toBe(400);

    const listed = (await api.call('connections.list', {})).connections.find((c) => c.id === id)!;
    expect(listed.oauth).toMatchObject({ status: 'connected', error: null });
    expect(await api.call('connections.runAction', { id, action: 'request', input: { path: 'me' } })).toMatchObject({
      result: { status: 200, body: { user: 'tim' } },
    });
  });

  it('refreshes tokens, keeps the refresh token, and asks to reconnect when it is revoked', async () => {
    const api = t.api(owner);
    const [ws] = (await t.srv.db.admin.query<{ workspace_id: string }>('SELECT workspace_id FROM connections WHERE id = $1', [id])).rows;
    await refreshConnection(t.srv.db, ws.workspace_id, id, { kp: t.srv.keyProvider, egress: t.srv.egress });
    expect(provider.tokenCalls.at(-1)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(await api.call('connections.runAction', { id, action: 'request', input: { path: 'me' } })).toMatchObject({
      result: { status: 200 },
    });

    provider.refuseRefresh = true;
    await refreshConnection(t.srv.db, ws.workspace_id, id, { kp: t.srv.keyProvider, egress: t.srv.egress });
    const listed = (await api.call('connections.list', {})).connections.find((c) => c.id === id)!;
    expect(listed.oauth?.status).toBe('error');
    expect(listed.oauth?.error).toContain('connect again');
  });
});

describe('shared rate limits', () => {
  it('count across processes in Valkey', async () => {
    const key = `test:${Date.now()}`;
    expect(await t.srv.hot.take(key, 1, 0.5, 2)).toBe(true);
    expect(await t.srv.hot.take(key, 1, 0.5, 2)).toBe(true);
    expect(await t.srv.hot.take(key, 1, 0.5, 2)).toBe(false);
  });
});
