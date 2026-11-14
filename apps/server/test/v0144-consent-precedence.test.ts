import { randomBytes } from 'node:crypto';
import { consentHook } from '@agentic-marketing/audience';
import type { BusEvent } from '@agentic-marketing/events';
import { recomputeConsentState } from '@agentic-marketing/profiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyDeliveryEvents } from '../../../packages/email/src/deliveryEvents';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.14.4 (#592, #625, #593, #626): personal-data reads are audited, the person page shows the
// consent delivery enforces per purpose and channel, and the journey preview asks the same

const PURPOSES = {
  purposes: [
    {
      key: 'marketing',
      name: 'Marketing',
      description: 'News and offers by e-mail and text.',
      basis: 'consent',
      channels: ['email', 'sms', 'webhook'],
      requiresDoubleOptIn: false,
      topics: [],
    },
    {
      key: 'tie',
      name: 'Tie',
      description: 'A purpose used for an equal-timestamp refusal.',
      basis: 'consent',
      channels: ['email'],
      requiresDoubleOptIn: false,
      topics: [],
    },
  ],
};

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let reader: User;
let ws: string;
let key: string;
let profileId: string;

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const seq = async () =>
  (await t.srv.db.admin.query<{ seq: string }>('SELECT coalesce(max(seq), 0) AS seq FROM audit_log WHERE workspace_id = $1', [ws])).rows[0]!
    .seq;

const auditSince = async (after: string, command: string) =>
  (
    await t.srv.db.admin.query(
      `SELECT command, principal_id, ok, target, input_hash FROM audit_log
       WHERE workspace_id = $1 AND seq > $2 AND command = $3 ORDER BY seq`,
      [ws, after, command],
    )
  ).rows;

beforeAll(async () => {
  t = await startTestServer('test_v0144_consent', testPort(3540));
  owner = await t.signUp(`consent-owner-${Date.now()}@example.com`);
  reader = await t.signUp(`consent-reader-${Date.now()}@example.com`);
  ws = await t.workspaceWith(
    [
      [owner, 'owner'],
      [reader, 'marketer'],
    ],
    'none',
  );
  const api = t.api(owner, ws);
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;

  const purposes = await api.call('artifacts.create', { type: 'purposes', name: 'Purposes', content: PURPOSES });
  await api.call('artifacts.requestPublish', { artifactId: purposes.artifactId, note: 'test' });

  await send([
    {
      type: 'identify',
      userId: 'v0144-person',
      traits: { email: 'v0144@example.com' },
    },
  ]);
  profileId = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'v0144-person' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  expect(profileId).toMatch(/^prf_/);
}, 60_000);

afterAll(() => t?.close());

describe('personal-data reads are audited (#592, #625)', () => {
  async function expectAudited(command: string, call: (api: ReturnType<typeof t.api>) => Promise<unknown>, target: string | null) {
    const api = t.api(reader, ws);
    const before = await seq();
    await call(api);
    const audit = await auditSince(before, command);
    expect(audit).toEqual([
      {
        command,
        principal_id: reader.id,
        ok: true,
        target,
        input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    // The lookup value and consent evidence stay out of the audit row in clear.
    expect(JSON.stringify(audit)).not.toContain('v0144@example.com');
  }

  it('profiles.find writes a read audit record naming the resolved person (#763)', async () => {
    await expectAudited('profiles.find', (api) => api.call('profiles.find', { type: 'email', value: 'v0144@example.com' }), profileId);
  });

  it('profiles.events writes a read audit record', async () => {
    await expectAudited('profiles.events', (api) => api.call('profiles.events', { profileId, limit: 10 }), profileId);
  });

  it('consent.history writes a read audit record', async () => {
    await expectAudited('consent.history', (api) => api.call('consent.history', { profileId }), profileId);
  });

  it('topics.preferences writes a read audit record', async () => {
    await expectAudited('topics.preferences', (api) => api.call('topics.preferences', { profileId }), profileId);
  });

  // The sweep also fixed the other per-person reads that lacked the flag.
  it('messages.list writes a read audit record', async () => {
    await expectAudited('messages.list', (api) => api.call('messages.list', { profileId, limit: 10 }), profileId);
  });

  it('segments.ofProfile writes a read audit record', async () => {
    await expectAudited('segments.ofProfile', (api) => api.call('segments.ofProfile', { profileId }), profileId);
  });

  it('profiles.scores writes a read audit record', async () => {
    await expectAudited('profiles.scores', (api) => api.call('profiles.scores', { profileId }), profileId);
  });

  // Sample profile ids are pseudonymous, but they identify people in this workspace.
  it('segments.preview writes a read audit record', async () => {
    await expectAudited(
      'segments.preview',
      (api) => api.call('segments.preview', { condition: { score: { key: 'conversion_propensity', gte: 0.5 } } }),
      null,
    );
  });

  it('deliveries.list writes a read audit record', async () => {
    await expectAudited('deliveries.list', (api) => api.call('deliveries.list', { limit: 10 }), null);
  });
});

describe('profiles.get reports the consent delivery enforces (#593)', () => {
  beforeAll(async () => {
    const api = t.api(owner, ws);
    // An all-channel grant, then a newer withdrawal on two channels.
    await api.call('consent.record', { profileId, purpose: 'marketing', status: 'granted', source: 'form' });
    await api.call('consent.record', {
      profileId,
      purpose: 'marketing',
      channel: 'sms',
      status: 'withdrawn',
      source: 'unsubscribe',
    });
    await api.call('consent.record', {
      profileId,
      purpose: 'marketing',
      channel: 'webhook',
      status: 'withdrawn',
      source: 'unsubscribe',
    });

    // Equal timestamps: a grant and a refusal, with the refusal winning the tie.
    await t.srv.db.admin.query(
      `INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
       VALUES ($1, $2, 'tie', '', 'granted', 'consent', 'form', '2026-01-01T00:00:00Z'),
              ($1, $2, 'tie', 'email', 'withdrawn', 'consent', 'unsubscribe', '2026-01-01T00:00:00Z')`,
      [ws, profileId],
    );
  });

  it('keeps the raw rows for the ledger', async () => {
    const p = await t.api(owner, ws).call('profiles.get', { profileId });
    expect(p.consent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'marketing', channel: '', status: 'granted' }),
        expect.objectContaining({ purpose: 'marketing', channel: 'sms', status: 'withdrawn' }),
        expect.objectContaining({ purpose: 'marketing', channel: 'webhook', status: 'withdrawn' }),
      ]),
    );
  });

  it('shows the channel withdrawal while the other channel stays allowed', async () => {
    const p = await t.api(owner, ws).call('profiles.get', { profileId });
    const marketing = p.consentEffective.find((c) => c.purpose === 'marketing')!;
    expect(marketing).toMatchObject({ basis: 'consent', status: 'withdrawn', allowed: false });
    expect(marketing.channels).toEqual(
      expect.arrayContaining([
        { channel: 'email', status: 'granted', allowed: true },
        { channel: 'sms', status: 'withdrawn', allowed: false },
        { channel: 'webhook', status: 'withdrawn', allowed: false },
      ]),
    );
  });

  it('resolves an equal-timestamp grant and refusal to the refusal', async () => {
    const p = await t.api(owner, ws).call('profiles.get', { profileId });
    const tie = p.consentEffective.find((c) => c.purpose === 'tie')!;
    expect(tie).toMatchObject({ status: 'withdrawn', allowed: false });
    expect(tie.channels).toEqual([{ channel: 'email', status: 'withdrawn', allowed: false }]);
  });
});

describe('an async consent write carries the action time (#928)', () => {
  // recorded_at is the precedence key (ADR-0014). Every async writer must pass the time the person
  // acted, not the time the worker, webhook or queue got to it.
  let hook: ReturnType<typeof consentHook>;
  const api = () => t.api(owner, ws);
  const newProfile = async () => {
    const id = `prf_${randomBytes(16).toString('hex')}`;
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, id]);
    return id;
  };
  const event = (profileId: string, name: string, timestamp: string, properties: Record<string, unknown>): BusEvent => ({
    workspaceId: ws,
    sourceId: 'frm_consent_time',
    messageId: `msg_${randomBytes(12).toString('hex')}`,
    type: 'track',
    name,
    anonymousId: '',
    userId: profileId,
    timestamp,
    receivedAt: timestamp,
    properties,
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  });
  const handle = (profileId: string, e: BusEvent) => hook(ws, [{ event: e, profileId }]);
  const history = async (profileId: string) => (await api().call('consent.history', { profileId })).records;
  const effective = async (profileId: string) =>
    (await api().call('profiles.get', { profileId })).consentEffective.find((c) => c.purpose === 'marketing')!;
  const withdraw = async (profileId: string) =>
    api().call('consent.record', { profileId, purpose: 'marketing', status: 'withdrawn', source: 'unsubscribe' });

  beforeAll(() => {
    hook = consentHook({
      db: t.srv.db,
      kp: t.srv.keyProvider,
      events: t.srv.events,
      links: t.srv.email.links,
      linksUrl: t.srv.linksUrl,
    });
  });

  it('a delayed form submission stays behind a later withdrawal', async () => {
    const profileId = await newProfile();
    await withdraw(profileId);
    const submittedAt = new Date(Date.now() - 60_000).toISOString();
    await handle(profileId, event(profileId, 'Form Submitted', submittedAt, { purposes: ['marketing'], double_opt_in: false }));
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
    expect((await history(profileId)).find((r) => r.status === 'granted')).toMatchObject({ recordedAt: submittedAt });
  });

  it('a delayed double-opt-in confirmation stays behind a later withdrawal', async () => {
    const profileId = await newProfile();
    await withdraw(profileId);
    const confirmedAt = new Date(Date.now() - 60_000).toISOString();
    await handle(profileId, event(profileId, 'Subscription Confirmed', confirmedAt, { purposes: ['marketing'], double_opt_in: true }));
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
    expect((await history(profileId)).find((r) => r.status === 'granted')).toMatchObject({ recordedAt: confirmedAt });
  });

  it('a redelivered form event creates no second record', async () => {
    const profileId = await newProfile();
    const submittedAt = new Date(Date.now() - 120_000).toISOString();
    const submitted = event(profileId, 'Form Submitted', submittedAt, { purposes: ['marketing'], double_opt_in: false });
    await handle(profileId, submitted);
    await withdraw(profileId);
    await handle(profileId, submitted);
    const records = await history(profileId);
    expect(records.filter((r) => r.status === 'granted')).toHaveLength(1);
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
  });

  it('a normal signup after a withdrawal still restores consent (ADR-0014)', async () => {
    const profileId = await newProfile();
    await withdraw(profileId);
    const submittedAt = new Date(Date.now() + 5).toISOString();
    await handle(profileId, event(profileId, 'Form Submitted', submittedAt, { purposes: ['marketing'], double_opt_in: false }));
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
  });

  it('a provider unsubscribe callback records the provider event time, not the webhook time', async () => {
    const profileId = await newProfile();
    await api().call('consent.record', { profileId, purpose: 'marketing', status: 'granted', source: 'form' });
    const messageId = `msg_${randomBytes(12).toString('hex')}`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status)
       VALUES ($1, $2, $3, 'email', 'marketing', $4, 'sent')`,
      [ws, messageId, `idem_${messageId}`, profileId],
    );
    const at = new Date(Date.now() - 60_000).toISOString();
    await t.srv.db.withWorkspace(ws, (tx) =>
      applyDeliveryEvents(tx, [{ eventId: 'evt-1', type: 'unsubscribed', messageId, at }], 'test', t.srv.keyProvider),
    );
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
    expect((await history(profileId)).find((r) => r.status === 'withdrawn')).toMatchObject({ recordedAt: at });
  });

  it('equal recorded_at times resolve a grant and a withdrawal to the withdrawal', async () => {
    const profileId = await newProfile();
    const at = '2026-10-01T10:00:00.000Z';
    // Both writers saw the same action time: the refusal must win the tie in consent_state, even
    // though the grant was written second (and so carries the higher id).
    await t.srv.db.admin.query(
      `INSERT INTO consent_records (workspace_id, profile_id, purpose, channel, status, basis, source, recorded_at)
       VALUES ($1, $2, 'marketing', '', 'withdrawn', 'consent', 'unsubscribe', $3),
              ($1, $2, 'marketing', '', 'granted', 'consent', 'form', $3)`,
      [ws, profileId, at],
    );
    await t.srv.db.withWorkspace(ws, (tx) => recomputeConsentState(tx, ws, profileId));
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
  });
});

describe('journeys.simulate previews refused webhooks (#626)', () => {
  let journeyId: string;

  beforeAll(async () => {
    const api = t.api(owner, ws);
    const endpoint = await api.call('webhooks.create', { name: 'CRM', url: 'https://example.com/crm' });
    journeyId = (
      await api.call('artifacts.create', {
        type: 'journey',
        name: 'Webhook preview',
        content: {
          purpose: 'marketing',
          nodes: [
            { id: 'start', kind: 'trigger', label: 'Started', config: { event: 'V0144 Started' } },
            { id: 'hook', kind: 'webhook', label: 'Send to CRM', config: { endpoint: endpoint.id }, next: [{ to: 'done' }] },
            { id: 'done', kind: 'exit', label: 'Done', config: {} },
          ],
        },
      })
    ).artifactId;
    await api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'test' });
  });

  it('says it would not send when a newer webhook withdrawal is behind an all-channel grant', async () => {
    const sim = await t.api(owner, ws).call('journeys.simulate', { artifactId: journeyId, profileId });
    const hook = sim.steps.find((s) => s.node === 'hook')!;
    expect(hook.detail).toContain('would not send');
    expect(hook.detail).toContain('no lawful basis');
  });

  // A simulation for a named person reveals their consent verdicts and branch data.
  it('writes a read audit record with the person as the target', async () => {
    const before = await seq();
    await t.api(owner, ws).call('journeys.simulate', { artifactId: journeyId, profileId });
    const audit = await auditSince(before, 'journeys.simulate');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ command: 'journeys.simulate', principal_id: owner.id, ok: true, target: profileId });
  });
});
