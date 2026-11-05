import { linkSigner } from '@agentic-marketing/email';
import type { EventBus } from '@agentic-marketing/events';
import { valkeyHotState } from '@agentic-marketing/hotstate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { type DoiToken, formsApi, takeFormSubmission } from '../src/forms';

// #380: the public form limiter is a shared hot-state bucket, so two app replicas enforce one
// per-form/client budget, independent keys stay independent, and an unreachable store refuses
// honestly instead of resetting every bucket or falling back to an unbounded local allowance.

const VALKEY_URL = process.env.VALKEY_URL;
const prefix = `am-forms-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const formId = `frm_${'a'.repeat(32)}`;
const otherFormId = `frm_${'b'.repeat(32)}`;

type Server = ReturnType<typeof formsApi>;

let t: DisposableDb;
let hot!: ReturnType<typeof valkeyHotState>;
const links = linkSigner('forms-test-secret');

const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;

const published = (server: Server) =>
  server.request(
    `/f/${formId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ email: 'ada@example.com' }),
    },
    env,
  );

function app(ratePerMinute = 2, extra: { hot?: typeof hot } = {}) {
  const events: unknown[] = [];
  const server = formsApi({
    db: t.db,
    bus: {
      publish: async (items: unknown[]) => {
        events.push(...items);
        return { accepted: items.length, duplicates: 0 };
      },
    } as unknown as EventBus,
    kp: {} as never,
    links,
    egress: { allowedHosts: [] } as never,
    hot: 'hot' in extra ? (extra.hot as typeof hot) : hot,
    clientIpHeaders: ['x-forwarded-for'],
    trustedProxyCidrs: ['127.0.0.1/32'],
    ratePerMinute,
  });
  return { server, events };
}

const formContent = (id: string) => ({
  purposes: ['marketing_email'],
  doubleOptIn: false,
  consentText: 'I agree to receive the newsletter.',
  successUrl: id === formId ? 'https://example.com/thanks' : 'https://example.com/other',
});

async function publishForm(id: string) {
  await t.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'form', 'Signup', 1, 1)`,
    [t.workspace, id],
  );
  await t.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, 'test', 'user', 'test')`,
    [t.workspace, id, JSON.stringify(formContent(id))],
  );
}

beforeAll(async () => {
  if (!hasTestDatabase() || !VALKEY_URL) return;
  t = await createDisposableDb('forms');
  hot = valkeyHotState({ url: VALKEY_URL, prefix });
  await publishForm(formId);
  await publishForm(otherFormId);
}, 120_000);

afterAll(async () => {
  hot?.close();
  if (t) await t.close();
});

const live = Boolean(process.env.TEST_DATABASE_URL && VALKEY_URL);

describe.skipIf(!live)('shared form submission limiter (#380)', () => {
  it('shares the same form and client budget across two app instances', async () => {
    const a = app(2).server;
    const b = app(2).server;
    // rate 2/min, burst 6: six submissions pass whichever replica serves them.
    for (let i = 0; i < 3; i++) expect((await published(a)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await published(b)).status).toBe(200);
    const limited = await published(b);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('leaves another form and another client untouched', async () => {
    const a = app(2).server;
    const other = await a.request(
      `/f/${otherFormId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ email: 'grace@example.com' }),
      },
      env,
    );
    expect(other.status).toBe(200);
    const otherClient = await a.request(
      `/f/${formId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4' },
        body: JSON.stringify({ email: 'linus@example.com' }),
      },
      env,
    );
    expect(otherClient.status).toBe(200);
  });

  it('does not reset an exhausted bucket when many other keys appear', async () => {
    const a = app(2).server;
    // A fresh client exhausts its own budget.
    const one = (ip: string) =>
      a.request(
        `/f/${formId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ email: 'x@example.com' }),
        },
        env,
      );
    for (let i = 0; i < 6; i++) expect((await one('192.0.2.77')).status).toBe(200);
    expect((await one('192.0.2.77')).status).toBe(429);
    // 200 other keys (well below any whole-map threshold, but the point is: no key evicts another).
    for (let i = 0; i < 200; i++) await one(`198.18.${Math.floor(i / 254)}.${(i % 254) + 1}`);
    expect((await one('192.0.2.77')).status).toBe(429);
  });

  it('uses the forwarded client only from a trusted proxy', async () => {
    const a = app(2).server;
    const viaProxy = (ip: string, remote: string) =>
      a.request(
        `/f/${formId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ email: 'p@example.com' }),
        },
        { incoming: { socket: { remoteAddress: remote } } } as never,
      );
    // The trusted loopback proxy's header is the client identity: exhaust it.
    for (let i = 0; i < 6; i++) expect((await viaProxy('203.0.113.50', '127.0.0.1')).status).toBe(200);
    expect((await viaProxy('203.0.113.50', '127.0.0.1')).status).toBe(429);
    // A direct, untrusted peer cannot borrow that client's exhausted bucket with a header.
    expect((await viaProxy('203.0.113.50', '198.51.100.8')).status).toBe(200);
  });

  it('still confirms a normal double opt-in link', async () => {
    const a = app(2);
    const token = links.sign({
      k: 'doi',
      w: t.workspace,
      f: formId,
      v: 1,
      a: 'anon-form-test',
      s: new Date().toISOString(),
      x: Date.now() + 60_000,
    } satisfies DoiToken);
    const res = await a.server.request(`/f/confirm/${token}`, { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(a.events.some((e) => (e as { name?: string }).name === 'Subscription Confirmed')).toBe(true);
  });

  it('refuses honestly when the shared store is missing or failing', async () => {
    const missing = app(2, { hot: undefined as never }).server;
    expect((await published(missing)).status).toBe(503);
    const failing = app(2, {
      hot: {
        take: async () => {
          throw new Error('valkey is down');
        },
      } as never,
    }).server;
    const res = await published(failing);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: 'rate_limit_unavailable' });
  });

  it('keeps the limiter decision account-agnostic: only the bucket matters', async () => {
    const hotStub = {
      take: async (key: string) => key === `form:${t.workspace}:${formId}:203.0.113.60`,
    };
    expect(await takeFormSubmission(hotStub, `${t.workspace}:${formId}:203.0.113.60`, 5)).toBe('ok');
    expect(await takeFormSubmission(hotStub, `${t.workspace}:${formId}:203.0.113.61`, 5)).toBe('limited');
    expect(await takeFormSubmission(undefined, `${t.workspace}:${formId}:203.0.113.62`, 5)).toBe('unavailable');
  });
});
