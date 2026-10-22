import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Phase 1 acceptance: "site events appear on a resolved profile within seconds; erasure verifiably
// removes a person". Runs the api, ingest and worker roles against Postgres, ClickHouse and NATS.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
const SHOP = 'https://shop.example.com';

beforeAll(async () => {
  t = await startTestServer('test_p1', 3298);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(() => t?.close());

const send = (key: string, body: unknown, opts: { origin?: string; path?: string } = {}) =>
  fetch(`${t.base}/v1/${opts.path ?? 'batch'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      ...(opts.origin === undefined ? { origin: SHOP } : opts.origin ? { origin: opts.origin } : {}),
    },
    body: JSON.stringify(body),
  });
const consent = (prefs: Record<string, boolean>) => ({ consent: { categoryPreferences: prefs } });

describe('sources and ingest', () => {
  let browserKey: string;

  it('creates sources: public browser keys, secret server keys shown once', async () => {
    const api = t.api(owner);
    expect((await rejects(api.call('sources.create', { name: 'Shop', kind: 'browser' }))).status).toBe(400);
    const browser = await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: [SHOP] });
    expect(browser).toMatchObject({ kind: 'browser', requiredPurpose: 'analytics', writeKey: browser.key });
    browserKey = browser.key;
    const server = await api.call('sources.create', { name: 'Backend', kind: 'server' });
    expect(server.key).toMatch(/^sk_/);
    const { sources } = await api.call('sources.list', {});
    expect(sources.find((s) => s.id === server.id)).toMatchObject({ writeKey: null, requiredPurpose: null });
    expect(JSON.stringify(sources)).not.toContain(server.key);
  });

  it('accepts consented events from allowed origins and drops the rest', async () => {
    const batch = [
      { type: 'page', name: 'Home', anonymousId: 'anon-1', messageId: 'p1', context: consent({ analytics: true }) },
      {
        type: 'track',
        event: 'Product Viewed',
        anonymousId: 'anon-1',
        messageId: 't1',
        properties: { sku: 'TENT-2' },
        context: consent({ analytics: true }),
      },
      { type: 'track', event: 'Product Viewed', anonymousId: 'anon-2', messageId: 't2', context: consent({ analytics: false }) },
      { type: 'track', anonymousId: 'anon-3' },
    ];
    const res = await send(browserKey, { batch });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(await res.json()).toMatchObject({ success: true, accepted: 2, dropped: 1, rejected: [{ index: 3 }] });

    // Retried batch: JetStream drops the duplicates.
    expect(await (await send(browserKey, { batch: batch.slice(0, 2) })).json()).toMatchObject({ accepted: 2, duplicates: 2 });
    expect((await send(browserKey, { batch }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('pk_nope', { batch })).status).toBe(401);
    expect((await send(browserKey, { batch: [] })).status).toBe(400);

    // Segment's single-event paths, and sendBeacon-style text/plain with the key in the body.
    expect(
      (await send(browserKey, { event: 'Signed Up', anonymousId: 'anon-1', context: consent({ analytics: true }) }, { path: 't' })).status,
    ).toBe(200);
    const beacon = await fetch(`${t.base}/v1/p`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: SHOP },
      body: JSON.stringify({ writeKey: browserKey, anonymousId: 'anon-1', name: 'Pricing', context: consent({ analytics: true }) }),
    });
    expect(await beacon.json()).toMatchObject({ accepted: 1 });

    const stored = await eventually(
      () => t.srv.events.eventsOf(ws, { anonymousIds: ['anon-1', 'anon-2'], userIds: [] }),
      (e) => e.length >= 4,
    );
    expect(stored.map((e) => e.name).sort()).toEqual(['Home', 'Pricing', 'Product Viewed', 'Signed Up']);
    expect(stored.find((e) => e.name === 'Product Viewed')?.properties).toEqual({ sku: 'TENT-2' });
  });

  it('answers CORS preflights', async () => {
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'OPTIONS',
      headers: { origin: SHOP, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST');
  });
});

describe('profiles, identity and consent', () => {
  let key: string;
  let marketer: User;
  let profileId: string;
  const yes = consent({ analytics: true });

  beforeAll(async () => {
    marketer = await t.signUp(`marketer-${Date.now()}@example.com`);
    await t.srv.db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'marketer')`, [
      ws,
      marketer.id,
    ]);
    key = (await t.api(owner).call('sources.create', { name: 'Shop 2', kind: 'browser', allowedOrigins: [SHOP] })).key;
  });

  it('resolves an anonymous visitor to a known person within seconds', async () => {
    const started = Date.now();
    await send(key, {
      batch: [
        { type: 'page', name: 'Tents', anonymousId: 'dev-a', timestamp: '2026-10-21T08:00:00Z', context: yes },
        {
          type: 'identify',
          timestamp: '2026-10-21T08:00:01Z',
          anonymousId: 'dev-a',
          userId: 'u-42',
          traits: { email: 'Ada@Example.com', firstName: 'Ada', plan: 'pro' },
          context: yes,
        },
      ],
    });
    const owners = t.api(owner);
    const found = await eventually(
      () => owners.call('profiles.find', { type: 'email', value: 'ada@example.com ' }),
      (r) => !!r.profileId,
    );
    profileId = found.profileId!;
    const events = await eventually(
      () => owners.call('profiles.events', { profileId }),
      (r) => r.events.length === 2,
    );
    expect(events.events.map((e) => e.name)).toEqual(['identify', 'Tents']);
    expect(Date.now() - started).toBeLessThan(5_000);

    const p = await owners.call('profiles.get', { profileId });
    expect(p.traits).toEqual({ plan: 'pro' });
    expect(p.personal).toEqual({ email: 'Ada@Example.com', firstName: 'Ada' });
    expect(p.identifiers.map((i) => i.type).sort()).toEqual(['anonymous_id', 'email', 'user_id']);

    // Personal data is encrypted at rest and only a hash is used for matching.
    const { rows } = await t.srv.db.admin.query(`SELECT value, value_enc FROM identifiers WHERE type = 'email'`);
    expect(JSON.stringify(rows)).not.toMatch(/ada@example\.com/i);
    const ch = await t.srv.events.eventsOf(ws, { anonymousIds: ['dev-a'], userIds: [] });
    expect(JSON.stringify(ch)).not.toContain('Ada@');
  });

  it('hides personal data from roles without profiles:pii', async () => {
    const p = await t.api(marketer).call('profiles.get', { profileId });
    expect(p.personal).toEqual({ email: '[hidden]', firstName: '[hidden]' });
    expect(p.identifiers.find((i) => i.type === 'email')?.value).toBe('[hidden]');
    expect((await rejects(t.api(marketer).call('profiles.export', { profileId }))).status).toBe(403);
  });

  it('merges a second device when it identifies with the same e-mail', async () => {
    await send(key, {
      batch: [
        { type: 'track', event: 'Product Viewed', anonymousId: 'dev-b', properties: { sku: 'TENT-2' }, context: yes },
        { type: 'identify', anonymousId: 'dev-b', traits: { email: 'ada@example.com', city: 'Aarhus' }, context: yes },
      ],
    });
    const api = t.api(owner);
    const merged = await eventually(
      () => api.call('profiles.get', { profileId }),
      (p) => p.identifiers.some((i) => i.value === 'dev-b'),
    );
    expect(merged.id).toBe(profileId);
    expect(merged.traits).toEqual({ plan: 'pro', city: 'Aarhus' });
    expect((await api.call('profiles.find', { type: 'anonymous_id', value: 'dev-b' })).profileId).toBe(profileId);
    const events = await eventually(
      () => api.call('profiles.events', { profileId }),
      (r) => r.events.length === 4,
    );
    expect(events.events.map((e) => e.name)).toContain('Product Viewed');
  });

  it('never joins two different user ids', async () => {
    await send(key, {
      batch: [{ type: 'identify', anonymousId: 'dev-c', userId: 'u-99', traits: { email: 'ada@example.com' }, context: yes }],
    });
    const api = t.api(owner);
    await eventually(
      () => api.call('profiles.find', { type: 'anonymous_id', value: 'dev-c' }),
      (r) => !!r.profileId,
    );
    expect((await api.call('profiles.find', { type: 'user_id', value: 'u-99' })).profileId).toBeNull();
    const p = await api.call('profiles.get', { profileId });
    expect(p.identifiers.filter((i) => i.type === 'user_id').map((i) => i.value)).toEqual(['u-42']);
  });

  it('records consent changes from the SDK in the ledger, and refuses agents granting consent', async () => {
    const change = (prefs: Record<string, boolean>, id: string) => ({
      type: 'track',
      event: 'Segment Consent Preference Updated',
      anonymousId: 'dev-a',
      messageId: id,
      context: { ...consent(prefs), userAgent: 'test' },
    });
    await send(key, { batch: [change({ analytics: true, marketing_email: true }, 'c1')] });
    await send(key, {
      batch: [change({ analytics: true, marketing_email: false }, 'c2'), change({ analytics: true, marketing_email: false }, 'c2')],
    });
    const api = t.api(owner);
    const history = await eventually(
      () => api.call('consent.history', { profileId }),
      (h) => h.records.length === 3,
    );
    expect(history.records.map((r) => `${r.purpose}:${r.status}:${r.source}`)).toEqual([
      'analytics:granted:sdk',
      'marketing_email:granted:sdk',
      'marketing_email:withdrawn:sdk',
    ]);
    expect(history.records[0].proof).toMatchObject({ messageId: 'c1', userAgent: 'test' });
    const p = await api.call('profiles.get', { profileId });
    expect(p.consent.find((c) => c.purpose === 'marketing_email')).toMatchObject({ status: 'withdrawn', basis: 'consent' });

    expect(
      await api.call('consent.record', {
        profileId,
        purpose: 'marketing_email',
        status: 'granted',
        source: 'form',
        proof: { form: 'newsletter-v3' },
      }),
    ).toEqual({
      recorded: true,
      allowed: true,
    });
    const { agentPrincipal } = await import('@agentic-marketing/commands');
    const { recordConsentCommand } = await import('@agentic-marketing/profiles');
    const agent = agentPrincipal(owner.id, 'test-agent', ws, 'owner', ['profiles:write']);
    await expect(
      t.srv.executor.execute(recordConsentCommand, { profileId, purpose: 'marketing_email', status: 'granted' }, agent, { surface: 'mcp' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await t.srv.executor.execute(recordConsentCommand, { profileId, purpose: 'marketing_email', status: 'objected' }, agent, {
        surface: 'mcp',
      }),
    ).toEqual({ recorded: true, allowed: false });
    expect((await rejects(api.call('consent.record', { profileId, purpose: 'telepathy', status: 'denied' }))).status).toBe(400);
  });

  it('exports everything about a person', async () => {
    const out = await t.api(owner).call('profiles.export', { profileId });
    expect(out.profile.personal).toMatchObject({ email: 'Ada@Example.com', firstName: 'Ada' });
    expect(out.events.length).toBeGreaterThanOrEqual(4);
    expect(out.consentRecords.length).toBe(5);
    const { entries } = await t.api(owner).call('audit.list', { limit: 50 });
    expect(entries.some((e) => e.command === 'profiles.export' && e.target === profileId)).toBe(true);
  });

  it('erases a person verifiably: events, identifiers, keys and ledger gone, e-mail suppressed', async () => {
    const api = t.api(owner);
    expect((await rejects(t.api(marketer).call('profiles.erase', { profileId, reason: 'x' }))).status).toBe(403);
    const before = await api.call('profiles.get', { profileId });
    const family = [profileId, ...before.mergedFrom];

    const res = await api.call('profiles.erase', { profileId, reason: 'Erasure request by e-mail' });
    expect(res).toMatchObject({ profiles: 2, consentRecords: 5 });

    expect((await api.call('profiles.find', { type: 'email', value: 'ada@example.com' })).profileId).toBeNull();
    expect((await rejects(api.call('profiles.get', { profileId }))).status).toBe(404);
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: ['dev-a', 'dev-b'], userIds: ['u-42'] })).toEqual([]);
    for (const table of ['profiles', 'profile_keys', 'identifiers', 'consent_state'])
      expect(
        (
          await t.srv.db.admin.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'profiles' ? 'id' : 'profile_id'} = ANY($1)`,
            [family],
          )
        ).rows[0].n,
      ).toBe(0);
    expect(
      (await t.srv.db.admin.query('SELECT count(*)::int AS n FROM consent_records WHERE profile_id = ANY($1)', [family])).rows[0].n,
    ).toBe(0);
    expect(
      (await t.srv.db.admin.query(`SELECT reason FROM suppressions WHERE workspace_id = $1 AND channel = 'email'`, [ws])).rows,
    ).toEqual([{ reason: 'erased' }]);
    const { rows } = await t.srv.db.admin.query('SELECT counts, reason FROM erasures WHERE workspace_id = $1', [ws]);
    expect(rows).toEqual([{ counts: { profiles: 2, identifiers: 5, consentRecords: 5 }, reason: 'Erasure request by e-mail' }]);
  });
});

describe('tracking plan at ingest', () => {
  it('removes personal properties and blocks events the published plan forbids', async () => {
    const owner2 = await t.signUp(`owner2-${Date.now()}@example.com`);
    const ws2 = await t.workspaceWith([[owner2, 'owner']], 'none');
    const api = t.api(owner2);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'tracking_plan',
      name: 'Tracking plan',
      content: {
        unknownEvents: 'block',
        events: [
          {
            name: 'Order Completed',
            properties: [
              { name: 'total', type: 'number', required: true },
              { name: 'address', pii: true },
            ],
          },
        ],
      },
    });
    expect((await rejects(api.call('artifacts.create', { type: 'tracking_plan', name: 'Second', content: {} }))).status).toBe(409);
    await api.call('artifacts.requestPublish', { artifactId, note: 'First plan' });
    const { key } = await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: ['*'], requiredPurpose: null });

    const res = await send(key, {
      batch: [
        { type: 'track', event: 'Order Completed', anonymousId: 'x1', properties: { total: 99, address: 'Main St 1' } },
        { type: 'track', event: 'Mystery', anonymousId: 'x1' },
      ],
    });
    expect(await res.json()).toMatchObject({
      accepted: 1,
      rejected: [{ index: 1, error: 'Event "Mystery" is not in the tracking plan.' }],
    });
    const stored = await eventually(
      () => t.srv.events.eventsOf(ws2, { anonymousIds: ['x1'], userIds: [] }),
      (e) => e.length === 1,
    );
    expect(stored[0].properties).toEqual({ total: 99 });
  });
});

describe('sdk-js against the gateway', () => {
  it('collects nothing before consent, then builds a profile with the consent on record', async () => {
    const { createAnalytics } = await import('@agentic-marketing/sdk-js');
    const owner3 = await t.signUp(`owner3-${Date.now()}@example.com`);
    const ws3 = await t.workspaceWith([[owner3, 'owner']]);
    const api = t.api(owner3);
    const { key } = await api.call('sources.create', { name: 'Site', kind: 'browser', allowedOrigins: ['*'] });
    const a = createAnalytics({
      writeKey: key,
      host: t.base,
      storage: null,
      page: () => ({ path: '/', url: 'https://x.example/', title: 'Home', referrer: '' }),
    });

    a.page('Home');
    await a.flush();
    a.setConsent({ analytics: true, marketing_email: true });
    a.identify('sdk-user', { email: 'sdk@example.com', plan: 'free' });
    await a.flush();

    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'sdk-user' }),
      (r) => !!r.profileId,
    );
    const p = await eventually(
      () => api.call('profiles.get', { profileId: profileId! }),
      (x) => x.consent.length === 2,
    );
    expect(p).toMatchObject({ traits: { plan: 'free' }, personal: { email: 'sdk@example.com' } });
    expect(p.consent.map((c) => `${c.purpose}:${c.status}`).sort()).toEqual(['analytics:granted', 'marketing_email:granted']);
    const { events } = await eventually(
      () => api.call('profiles.events', { profileId: profileId! }),
      (r) => r.events.length === 3,
    );
    expect(events.map((e) => e.name).sort()).toEqual(['Home', 'Segment Consent Preference Updated', 'identify']);
    expect(ws3).toBeTruthy();
  });
});
