import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// 0.14.7 forms (#597): an allowed origin is stored lowercased and compared case-insensitively,
// so a site entered as https://MySite.com still accepts the lowercased Origin a browser sends.

const SITE = 'https://MySite.com';
let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let formId = '';

const api = () => t.api(owner);

const submit = (origin: string | undefined, email = `origin-${Date.now()}@example.com`, json = false) =>
  fetch(`${t.base}/f/${formId}`, {
    method: 'POST',
    headers: {
      'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {}),
    },
    body: json ? JSON.stringify({ email }) : new URLSearchParams({ email }).toString(),
    redirect: 'manual',
  });

beforeAll(async () => {
  t = await startTestServer('test_v0147_forms', testPort(4401));
  owner = await t.signUp(`forms-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const created = await t.api(owner).call('artifacts.create', {
    type: 'form',
    name: 'Mixed-case site',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: false,
      consentText: 'Send me the newsletter.',
      successUrl: `${SITE}/thanks`,
      allowedOrigins: [SITE],
    },
  });
  formId = created.artifactId;
  await t.api(owner).call('artifacts.requestPublish', { artifactId: formId, note: 'origin case test' });
}, 60_000);
afterAll(() => t?.close());

describe('form allowed origins (#597)', () => {
  it('stores the origin lowercased when a form is saved', async () => {
    const got = await api().call('artifacts.get', { artifactId: formId });
    expect((got.version.content as { allowedOrigins: string[] }).allowedOrigins).toEqual(['https://mysite.com']);
  });

  it('accepts a submission whose Origin differs only in case', async () => {
    const res = await submit('https://mysite.com');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${SITE}/thanks`);
  });

  it('still refuses a different host', async () => {
    const res = await submit('https://evil.example');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${SITE}/thanks?error=origin_not_allowed`);
    const json = await submit('https://evil.example', `origin-json-${Date.now()}@example.com`, true);
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ ok: false, error: 'origin_not_allowed' });
  });
});
