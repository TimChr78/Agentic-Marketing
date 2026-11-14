import { createHmac } from 'node:crypto';
import http from 'node:http';
import { SSO_SAML_CALLBACK_MAX_BODY, SSO_SAML_MAX_RESPONSE_BYTES } from '@agentic-marketing/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startTestServer, testPort, type User } from './harness';
import { findUnboundedRoutes } from './route-sweep';

// #235/#242: public ingest, inbound webhooks and the unauthenticated form, decision, preference,
// SMS and REST POSTs must refuse oversized bodies before buffering them, counting encoded bytes
// rather than JavaScript string length. A chunked body has no Content-Length, so the limit has to
// be enforced on the stream.

const PORT = testPort(3459);
const SITE = 'https://limits.example';
const SIGNING_SECRET = 'limits-signing-secret-0123456789';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let workspaceId = '';
let writeKey = '';
let formId = '';
let inboundPath = '';

/** POST a chunked body without Content-Length, writing slowly so an early answer is observable. */
function postChunked(
  path: string,
  opts: { total: number; headers?: Record<string, string> },
): Promise<{ status: number; body: string; writtenAtResponse: number }> {
  return new Promise((resolve, reject) => {
    const chunkSize = 64 * 1024;
    const payload = Buffer.alloc(chunkSize, 'a');
    const total = opts.total;
    let written = 0;
    let settled = false;
    let responding = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: { status: number; body: string; writtenAtResponse: number }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      },
      (res) => {
        responding = true;
        if (timer) clearTimeout(timer);
        const writtenAtResponse = written;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => finish({ status: res.statusCode ?? 0, body, writtenAtResponse }));
        res.on('close', () => finish({ status: res.statusCode ?? 0, body, writtenAtResponse }));
      },
    );
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    const pump = () => {
      if (settled || responding) return;
      if (written >= total) {
        req.end();
        return;
      }
      const n = Math.min(chunkSize, total - written);
      written += n;
      req.write(payload.subarray(0, n));
      timer = setTimeout(pump, 1);
    };
    pump();
  });
}

const oversize = (bytes: number) => 'a'.repeat(bytes);

/** POST a small chunked body without Content-Length, all in one go. */
function postChunkedText(path: string, text: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    const bytes = Buffer.from(text);
    req.write(bytes.subarray(0, 10));
    req.write(bytes.subarray(10));
    req.end();
  });
}

beforeAll(async () => {
  t = await startTestServer('test_body_limits', PORT);
  owner = await t.signUp(`limits-${Date.now()}@example.com`);
  workspaceId = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  writeKey = (await api.call('sources.create', { name: 'Limits', kind: 'server' })).key;
  const form = await api.call('artifacts.create', {
    type: 'form',
    name: 'Limits form',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: false,
      consentText: 'Send me the newsletter.',
      successUrl: `${SITE}/thanks`,
      confirmedUrl: `${SITE}/welcome`,
      allowedOrigins: [SITE],
    },
  });
  await api.call('artifacts.requestPublish', { artifactId: form.artifactId, note: 'body limits' });
  formId = form.artifactId;
  const connection = await api.call('connections.create', {
    connector: 'salesforce',
    name: 'Limits callouts',
    settings: { instanceUrl: 'https://limits.my.salesforce.com', loginUrl: 'https://login.salesforce.com' },
    secrets: { clientId: 'limits-client', clientSecret: 'limits-secret', signingSecret: SIGNING_SECRET },
  });
  inboundPath = connection.inboundPath!;
}, 60_000);
afterAll(() => t?.close());

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  redirect: 'manual' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
  body: new URLSearchParams(fields).toString(),
});

describe('public ingest (#235)', () => {
  it('refuses an oversized body with a correct Content-Length', async () => {
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}` },
      body: JSON.stringify({ batch: [{ type: 'page', anonymousId: 'a', name: oversize(600 * 1024) }] }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ success: false, error: 'too_large' });
  });

  it('refuses an oversized chunked body before reading all of it', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/v1/batch', {
      total,
      headers: { authorization: `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}` },
    });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('counts encoded bytes, not string length', async () => {
    // 300,000 characters, 600,000 UTF-8 bytes: under the 500 KB string check, over the byte limit.
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}` },
      body: JSON.stringify({ batch: [{ type: 'page', anonymousId: 'a', name: 'é'.repeat(300_000) }] }),
    });
    expect(res.status).toBe(413);
  });

  it('still accepts a normal batch', async () => {
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}` },
      body: JSON.stringify({
        batch: [{ type: 'page', anonymousId: 'a', name: 'Limits', context: { consent: { categoryPreferences: { analytics: true } } } }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('still accepts a normal chunked batch without Content-Length', async () => {
    const res = await postChunkedText('/v1/batch', JSON.stringify({ batch: [{ type: 'page', anonymousId: 'a', name: 'Chunked' }] }), {
      authorization: `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}`,
    });
    expect(res.status).toBe(200);
  });
});

describe('inbound webhook (#235)', () => {
  it('refuses an oversized signed body with a correct Content-Length', async () => {
    const body = JSON.stringify({
      sobject: 'Contact',
      recordId: '003000000000009AAA',
      email: 'a@example.com',
      padding: oversize(2 * 1024 * 1024),
    });
    const signature = createHmac('sha256', SIGNING_SECRET).update(body).digest('hex');
    const res = await fetch(`${t.base}${inboundPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-am-signature': signature },
      body,
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked body before authenticating the secret URL', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked(inboundPath, { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still accepts a normal signed webhook', async () => {
    const body = JSON.stringify({ sobject: 'Contact', recordId: '003000000000009AAA', email: 'limits@example.com', event: 'Limits' });
    const signature = createHmac('sha256', SIGNING_SECRET).update(body).digest('hex');
    const res = await fetch(`${t.base}${inboundPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-am-signature': signature },
      body,
    });
    expect(res.status).toBe(200);
  });
});

describe('forms (#242)', () => {
  it('refuses an oversized body with a correct Content-Length', async () => {
    const res = await fetch(`${t.base}/f/${formId}`, form({ email: 'a@example.com', name: oversize(100 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked body without Content-Length', async () => {
    const res = await postChunked(`/f/${formId}`, {
      total: 8 * 1024 * 1024,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
    });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(8 * 1024 * 1024);
  });

  it('counts encoded bytes, not string length', async () => {
    const res = await fetch(`${t.base}/f/${formId}`, form({ email: 'a@example.com', name: 'é'.repeat(40_000) }));
    expect(res.status).toBe(413);
  });

  it('still accepts a normal submission', async () => {
    const res = await fetch(`${t.base}/f/${formId}`, form({ email: `reader-${Date.now()}@example.com` }));
    expect(res.status).toBe(303);
  });
});

describe('decision API (#242)', () => {
  it('refuses an oversized body with a correct Content-Length', async () => {
    const res = await fetch(`${t.base}/v1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ writeKey, placements: ['home'], context: { pad: oversize(100 * 1024) } }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked body without Content-Length', async () => {
    const res = await postChunked('/v1/decide', { total: 8 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(8 * 1024 * 1024);
  });

  it('counts encoded bytes, not string length', async () => {
    // 20,000 characters, 40,000 UTF-8 bytes: under a 32 KB string check, over the byte limit.
    const res = await fetch(`${t.base}/v1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ writeKey, placements: ['home'], context: { pad: 'é'.repeat(20_000) } }),
    });
    expect(res.status).toBe(413);
  });

  it('still answers a normal decision request', async () => {
    const res = await fetch(`${t.base}/v1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ writeKey, placements: ['home'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decisions: [] });
  });
});

describe('REST commands (#242)', () => {
  it('refuses an oversized body with a correct Content-Length before authenticating', async () => {
    const res = await fetch(`${t.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: oversize(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked body without Content-Length', async () => {
    const res = await postChunked('/v1/workspace.get', { total: 8 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(8 * 1024 * 1024);
  });

  it('counts encoded bytes, not string length', async () => {
    // 600,000 characters, 1,200,000 UTF-8 bytes: under a 1 MB string check, over the byte limit.
    const res = await fetch(`${t.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'é'.repeat(600_000) }),
    });
    expect(res.status).toBe(413);
  });

  it('still answers a normal command', async () => {
    const res = await fetch(`${t.base}/v1/workspace.get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': workspaceId },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});

// #377: these routes read the whole body before any size or auth check. The 413 has to arrive
// before the write key, the webhook token, the SCIM bearer token or the session is looked at, and
// a chunked body without Content-Length must be refused while the client is still writing.

describe('push subscription (#377)', () => {
  it('refuses an oversized body with a correct Content-Length before the write-key check', async () => {
    const res = await fetch(`${t.base}/v1/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anonymousId: 'limits', pad: oversize(100 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('refuses an oversized chunked body before reading all of it', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/v1/push/subscribe', { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still accepts a normal subscription', async () => {
    const res = await fetch(`${t.base}/v1/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}` },
      body: JSON.stringify({ userId: 'limits-user', kind: 'fcm', token: 'limits-fcm-token-012345' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('e-mail delivery webhook (#377)', () => {
  it('refuses an oversized body with a correct Content-Length before the token lookup', async () => {
    const res = await fetch(`${t.base}/hooks/email/x/y`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: oversize(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked body without Content-Length', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/hooks/email/x/y', { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still reaches the token check for a normal body', async () => {
    const res = await fetch(`${t.base}/hooks/email/x/y`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('SCIM (#377)', () => {
  it('refuses an oversized body with a correct Content-Length before the bearer check', async () => {
    const res = await fetch(`${t.base}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'a@example.com', pad: oversize(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: '413' });
  });

  it('refuses an oversized chunked body without Content-Length', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/scim/v2/Users', { total, headers: { authorization: 'Bearer not-a-token' } });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still checks the token for a normal body', async () => {
    const res = await fetch(`${t.base}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-token' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('invitation acceptance (#377)', () => {
  it('refuses an oversized body with a correct Content-Length before the session lookup', async () => {
    const res = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x', pad: oversize(100 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked body without Content-Length', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/api/invitations/accept', { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still answers the session check for a normal body', async () => {
    const res = await fetch(`${t.base}/api/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

// #790: the consent route read and replayed the whole body before Better Auth's session check,
// so it was the one unauthenticated POST on the main listener with no cap. A consent form is
// tiny; the limit is applied before the read, and a 50 MB chunked body is refused while it is
// still arriving.
describe('OAuth consent (#790)', () => {
  it('refuses an oversized consent body with a correct Content-Length', async () => {
    const res = await fetch(`${t.base}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ accept: true, oauth_query: 'client_id=limits', pad: oversize(64 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('refuses a 50 MB chunked consent body before reading it', async () => {
    const total = 50 * 1024 * 1024;
    const res = await postChunked('/api/auth/oauth2/consent', { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still answers the session check for a normal consent body', async () => {
    const res = await fetch(`${t.base}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ accept: true, oauth_query: 'client_id=limits' }),
    });
    expect(res.status).not.toBe(413);
  });
});

// #932: Better Auth's catch-all forwards sign-in, sign-up, OAuth token and SSO registration bodies
// to `auth.handler`, which reads the whole body before its own checks. The catch-all needs the
// same guard as the consent route it sits below.
describe('Better Auth catch-all (#932)', () => {
  it('refuses an oversized sign-in body with a correct Content-Length', async () => {
    const res = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email: owner.email, password: PASSWORD, pad: oversize(512 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('refuses an oversized chunked sign-up body without Content-Length while it is still arriving', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/api/auth/sign-up/email', { total, headers: { origin: t.base } });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still signs in normally', async () => {
    const res = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email: owner.email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
  });

  it('still accepts a normal chunked sign-in without Content-Length', async () => {
    const res = await postChunkedText('/api/auth/sign-in/email', JSON.stringify({ email: owner.email, password: PASSWORD }), {
      origin: t.base,
    });
    expect(res.status).toBe(200);
  });
});

// #932 review A1: the ACS accepts a SAMLResponse up to SSO_SAML_MAX_RESPONSE_BYTES. A form at that
// maximum must not be refused by the catch-all's 256 KB; only the route's own derived ceiling
// applies, and one byte over it is a 413.
describe('SAML callbacks (#932 A1)', () => {
  it('accepts a maximum-size SAMLResponse even at worst-case form encoding', async () => {
    const body = new URLSearchParams({ SAMLResponse: '%'.repeat(SSO_SAML_MAX_RESPONSE_BYTES) }).toString();
    expect(body.length).toBeGreaterThan(256 * 1024);
    const res = await fetch(`${t.base}/api/auth/sso/saml2/sp/acs/limits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.base },
      body,
    });
    expect(res.status).not.toBe(413);
  });

  it('refuses a body one byte over the SAML route limit', async () => {
    const body = `SAMLResponse=${'A'.repeat(SSO_SAML_CALLBACK_MAX_BODY)}`;
    expect(body.length).toBeGreaterThan(SSO_SAML_CALLBACK_MAX_BODY);
    const res = await fetch(`${t.base}/api/auth/sso/saml2/sp/acs/limits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.base },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });
});

// #932: the sweep. Every route that can read a request body (including ALL registrations and
// body-reading middleware) has a bodyLimit, either on the route itself or on a matching guard
// registered before it. The allow-list and its reasons live with the sweep in ./route-sweep.ts.
describe('body-limit route sweep (#932)', () => {
  it('gives every body-accepting route its own limit', () => {
    expect(findUnboundedRoutes(t.srv.app)).toEqual([]);
  });
});

describe('password reset and copilot (#347)', () => {
  it('refuses an oversized password-reset body before doing any work', async () => {
    const res = await fetch(`${t.base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', pad: oversize(100 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked password-reset body without Content-Length', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/api/auth/request-password-reset', { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still validates a normal password-reset body', async () => {
    const res = await fetch(`${t.base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-address' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an oversized copilot body before the session check', async () => {
    const res = await fetch(`${t.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', pad: oversize(100 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses an oversized chunked copilot body without Content-Length', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/api/copilot', { total });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still answers the copilot session check for a normal body', async () => {
    const res = await fetch(`${t.base}/api/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });
});
