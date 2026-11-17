import { randomBytes } from 'node:crypto';
import type { Purposes } from '@agentic-marketing/artifacts';
import { consentHook, dispatchOutboxOnce } from '@agentic-marketing/audience';
import type { BusEvent } from '@agentic-marketing/events';
import { recordConsentEvidence, withIdentityLock } from '@agentic-marketing/profiles';
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
    {
      key: 'onboarding',
      name: 'Onboarding',
      description: 'Confirm a subscription before it starts.',
      basis: 'contract',
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
  let doiForm = '';
  let doiFormVersion = 0;
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

  beforeAll(async () => {
    hook = consentHook({
      db: t.srv.db,
      links: t.srv.email.links,
      linksUrl: t.srv.linksUrl,
    });
    const template = await api().call('artifacts.create', {
      type: 'email_template',
      name: 'DOI confirmation',
      content: {
        purpose: 'onboarding',
        subject: 'Confirm your subscription',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text><mj-text><a href="{{ confirm_url | raw }}">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    });
    await api().call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'test' });
    const form = await api().call('artifacts.create', {
      type: 'form',
      name: 'DOI form',
      content: {
        purposes: ['marketing'],
        doubleOptIn: true,
        confirmationTemplate: template.artifactId,
        consentText: 'Send me the newsletter.',
        successUrl: 'https://example.com/check-inbox',
        confirmedUrl: 'https://example.com/welcome',
        errorUrl: 'https://example.com/error',
        allowedOrigins: [],
      },
    });
    doiForm = form.artifactId;
    doiFormVersion = (await api().call('artifacts.requestPublish', { artifactId: doiForm, note: 'test' })).version;
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

  it('clamps a future-dated imported consent to the import time', async () => {
    const email = `future-${randomBytes(6).toString('hex')}@example.com`;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const imported = await api().call('profiles.import', {
      label: 'Future consent',
      rows: [{ email, consent: [{ purpose: 'marketing', status: 'granted', recordedAt: future }] }],
    });
    expect(imported.accepted).toBe(1);
    const found = await eventually(
      () => api().call('profiles.find', { type: 'email', value: email }),
      (r) => !!r.profileId,
    );
    const profileId = found.profileId!;
    const { records } = await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.length > 0,
    );
    // Historical evidence is kept, but a date in the future cannot outrank a later withdrawal.
    expect(new Date(records.find((r) => r.status === 'granted')!.recordedAt).getTime()).toBeLessThanOrEqual(Date.now());
    await withdraw(profileId);
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
  });

  it('an identical future-dated re-import after a withdrawal writes nothing new', async () => {
    const email = `future-retry-${randomBytes(6).toString('hex')}@example.com`;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const rows = [{ email, consent: [{ purpose: 'marketing', status: 'granted' as const, recordedAt: future }] }];
    const label = 'Future retry';
    await api().call('profiles.import', { label, rows });
    const found = await eventually(
      () => api().call('profiles.find', { type: 'email', value: email }),
      (r) => !!r.profileId,
    );
    const profileId = found.profileId!;
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.length > 0,
    );
    await withdraw(profileId);
    const before = (await history(profileId)).length;

    // The identical row derives the same event id as the first import, so the retry is deduplicated
    // and can neither append a grant stamped now nor restore the withdrawn consent.
    await api().call('profiles.import', { label, rows });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await history(profileId)).length).toBe(before);
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
  });

  it('a DOI confirmation redelivery after the profile merged replays the confirmation', async () => {
    const tag = randomBytes(5).toString('hex');
    const emailA = `doi-a-${tag}@example.com`;
    const emailB = `doi-b-${tag}@example.com`;
    await api().call('profiles.import', {
      label: 'DOI merge',
      rows: [emailA, emailB].map((email) => ({
        email,
        consent: [{ purpose: 'marketing', status: 'granted' as const }],
      })),
    });
    const a = (
      await eventually(
        () => api().call('profiles.find', { type: 'email', value: emailA }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    const b = (
      await eventually(
        () => api().call('profiles.find', { type: 'email', value: emailB }),
        (r) => !!r.profileId,
      )
    ).profileId!;

    const submitted = event(a, 'Form Submitted', new Date().toISOString(), {
      form_id: doiForm,
      form_version: doiFormVersion,
      purposes: ['marketing'],
      double_opt_in: true,
    });
    await handle(a, submitted);
    const key = `doi:${submitted.messageId}`;
    const count = async () =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND idempotency_key = $2',
          [ws, key],
        )
      ).rows[0]!.n;
    const intents = async () =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND kind = 'doi_send' AND operation_key = $2`,
          [ws, key],
        )
      ).rows[0]!.n;
    // The consent transaction writes one durable intent; the dispatcher (or the test server's
    // scheduler) then creates the confirmation message (#978 part 2).
    expect(await intents()).toBe(1);
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    await eventually(count, (n) => n === 1);

    // A later hook in the same batch failed before the event was acknowledged; the person is merged
    // and the redelivery now resolves to the survivor. The request itself did not change.
    await t.srv.db.admin.query(
      `INSERT INTO profile_merges (workspace_id, from_id, into_id, reason) VALUES ($1, $2, $3, 'redelivery test')`,
      [ws, a, b],
    );
    await t.srv.db.admin.query('UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2', [ws, a, b]);
    await t.srv.db.admin.query('DELETE FROM consent_state WHERE workspace_id = $1 AND profile_id = $2', [ws, a]);
    await handle(b, submitted);
    // The redelivered submission adds no second intent, and re-running the delivered one replays the
    // message instead of sending again (the dispatcher died after the send but before its ack).
    expect(await intents()).toBe(1);
    await t.srv.db.admin.query(
      `UPDATE outbox SET state = 'pending', lease_until = NULL, delivered_at = NULL
       WHERE workspace_id = $1 AND kind = 'doi_send' AND operation_key = $2`,
      [ws, key],
    );
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    await eventually(count, (n) => n === 1);
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
    await t.srv.db.withWorkspace(ws, (tx) => applyDeliveryEvents(tx, [{ eventId: 'evt-1', type: 'unsubscribed', messageId, at }], 'test'));
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
    expect((await history(profileId)).find((r) => r.status === 'withdrawn')).toMatchObject({ recordedAt: at });
  });

  it('equal recorded_at times resolve a grant and a withdrawal to the withdrawal', async () => {
    const profileId = await newProfile();
    const at = '2026-10-01T10:00:00.000Z';
    // Both writers saw the same action time: the refusal must win the tie in consent_state, even
    // though the grant was written first and the withdrawal (which rebuilds the state) second.
    await t.srv.db.admin.query(
      `INSERT INTO consent_records (workspace_id, profile_id, purpose, channel, status, basis, source, recorded_at)
       VALUES ($1, $2, 'marketing', '', 'granted', 'consent', 'form', $3)`,
      [ws, profileId, at],
    );
    await t.srv.db.withWorkspace(ws, (tx) =>
      withIdentityLock(tx, ws, () =>
        recordConsentEvidence(tx, ws, profileId, PURPOSES.purposes as unknown as Purposes, [
          {
            purpose: 'marketing',
            channel: '',
            status: 'withdrawn',
            source: 'unsubscribe',
            proof: {},
            recordedAt: new Date(at),
          },
        ]),
      ),
    );
    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
  });
});

describe('a newer same-status signup is consent evidence (#936)', () => {
  // The ledger used to keep a row only when the current status changed. A signup while already
  // granted was therefore dropped, and a withdrawal whose provider callback arrived later could
  // win although the person's latest action was the signup.
  let hook: ReturnType<typeof consentHook>;
  const api = () => t.api(owner, ws);
  const newProfile = async () => {
    const id = `prf_${randomBytes(16).toString('hex')}`;
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, id]);
    return id;
  };
  const formEvent = (profileId: string, at: Date): BusEvent => ({
    workspaceId: ws,
    sourceId: 'frm_936',
    messageId: `msg_${randomBytes(12).toString('hex')}`,
    type: 'track',
    name: 'Form Submitted',
    anonymousId: '',
    userId: profileId,
    timestamp: at.toISOString(),
    receivedAt: at.toISOString(),
    properties: { purposes: ['marketing'], double_opt_in: false },
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  });
  const handle = (profileId: string, e: BusEvent) => hook(ws, [{ event: e, profileId }]);
  const history = async (profileId: string) => (await api().call('consent.history', { profileId })).records;
  const effective = async (profileId: string) =>
    (await api().call('profiles.get', { profileId })).consentEffective.find((c) => c.purpose === 'marketing')!;
  const providerUnsubscribe = async (profileId: string, at: Date) => {
    const messageId = `msg_${randomBytes(12).toString('hex')}`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status)
       VALUES ($1, $2, $3, 'email', 'marketing', $4, 'sent')`,
      [ws, messageId, `idem_${messageId}`, profileId],
    );
    await t.srv.db.withWorkspace(ws, (tx) =>
      applyDeliveryEvents(
        tx,
        [{ eventId: `evt_${randomBytes(6).toString('hex')}`, type: 'unsubscribed', messageId, at: at.toISOString() }],
        'test',
      ),
    );
  };

  beforeAll(() => {
    hook = consentHook({
      db: t.srv.db,
      links: t.srv.email.links,
      linksUrl: t.srv.linksUrl,
    });
  });

  it('keeps the signup at T2 and resolves to granted when the withdrawal at T1 arrives late', async () => {
    const profileId = await newProfile();
    // All three actions are minutes apart and the decisive one is processed last: no time window
    // can be allowed to fold the signup against the older grant.
    const t0 = new Date(Date.now() - 30 * 60_000);
    const t1 = new Date(Date.now() - 20 * 60_000);
    const t2 = new Date(Date.now() - 10 * 60_000);

    await handle(profileId, formEvent(profileId, t0));
    // The person signs up again while the ledger still says granted: the provider's withdrawal
    // callback for T1 has not arrived yet.
    await handle(profileId, formEvent(profileId, t2));
    const grants = (await history(profileId)).filter((r) => r.status === 'granted');
    expect(grants).toHaveLength(2);

    // The delayed callback now records the withdrawal at its own (older) action time.
    await providerUnsubscribe(profileId, t1);
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
    const records = await history(profileId);
    expect(records.find((r) => r.status === 'withdrawn')).toMatchObject({ recordedAt: t1.toISOString() });
    expect(records.filter((r) => r.status === 'granted')).toHaveLength(2);
  });

  it('keeps the newer withdrawal when a delayed grant is processed last (the mirror ordering)', async () => {
    const profileId = await newProfile();
    const t0 = new Date(Date.now() - 30 * 60_000);
    const t10 = new Date(Date.now() - 20 * 60_000);
    const t20 = new Date(Date.now() - 10 * 60_000);

    await providerUnsubscribe(profileId, t0);
    // A second withdrawal while the status is already withdrawn is a distinct action: folding it
    // would let the delayed grant at T10 look like the newest action.
    await providerUnsubscribe(profileId, t20);
    await handle(profileId, formEvent(profileId, t10));

    expect(await effective(profileId)).toMatchObject({ status: 'withdrawn', allowed: false });
    const records = await history(profileId);
    expect(records.filter((r) => r.status === 'withdrawn')).toHaveLength(2);
    expect(records.find((r) => r.status === 'withdrawn' && r.recordedAt === t20.toISOString())).toBeDefined();
    // The delayed grant is kept as evidence but is older than the T20 withdrawal.
    expect(records.filter((r) => r.status === 'granted')).toHaveLength(1);
  });

  it('keeps a second signup minutes later as a distinct action', async () => {
    const profileId = await newProfile();
    const first = new Date(Date.now() - 30 * 60_000);
    const repeat = new Date(Date.now() - 20 * 60_000);
    await handle(profileId, formEvent(profileId, first));
    await handle(profileId, formEvent(profileId, repeat));
    expect((await history(profileId)).filter((r) => r.status === 'granted')).toHaveLength(2);
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
  });

  it('does not add a row for a redelivered event', async () => {
    const profileId = await newProfile();
    const submitted = formEvent(profileId, new Date(Date.now() - 30 * 60_000));
    await handle(profileId, submitted);
    const before = (await history(profileId)).length;
    await handle(profileId, submitted);
    expect((await history(profileId)).length).toBe(before);
  });

  it('does not add a row when a provider redelivers the same event id', async () => {
    const profileId = await newProfile();
    await handle(profileId, formEvent(profileId, new Date(Date.now() - 5 * 3_600_000)));
    const messageId = `msg_${randomBytes(12).toString('hex')}`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status)
       VALUES ($1, $2, $3, 'email', 'marketing', $4, 'sent')`,
      [ws, messageId, `idem_${messageId}`, profileId],
    );
    const eventId = `evt_${randomBytes(6).toString('hex')}`;
    const redeliver = (at: Date) =>
      t.srv.db.withWorkspace(ws, (tx) =>
        applyDeliveryEvents(tx, [{ eventId, type: 'unsubscribed', messageId, at: at.toISOString() }], 'test'),
      );
    await redeliver(new Date(Date.now() - 3 * 3_600_000));
    // The same event id again with a later action time: the event identity still deduplicates it.
    await redeliver(new Date());
    expect((await history(profileId)).filter((r) => r.status === 'withdrawn')).toHaveLength(1);
  });

  it('keeps an older re-signup as evidence without changing the newer outcome', async () => {
    const profileId = await newProfile();
    const newest = new Date(Date.now() - 10 * 60_000);
    const older = new Date(Date.now() - 20 * 60_000);
    await handle(profileId, formEvent(profileId, newest));
    await handle(profileId, formEvent(profileId, older));
    expect(await history(profileId)).toHaveLength(2);
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
  });

  it('the SDK carries the same rule: a newer same-status choice is evidence', async () => {
    const anonymousId = `dev-936-${randomBytes(5).toString('hex')}`;
    const change = (at: Date, allowed: boolean) => ({
      type: 'track',
      event: 'Segment Consent Preference Updated',
      anonymousId,
      timestamp: at.toISOString(),
      context: { consent: { categoryPreferences: { marketing: allowed } } },
    });
    const t0 = new Date(Date.now() - 3 * 3_600_000);
    const t1 = new Date(Date.now() - 2 * 3_600_000);
    const t2 = new Date(Date.now() - 60_000);
    await send([change(t0, true)]);
    const found = await eventually(
      () => api().call('profiles.find', { type: 'anonymous_id', value: anonymousId }),
      (r) => !!r.profileId,
    );
    const profileId = found.profileId!;
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.length === 1,
    );
    await send([change(t2, true)]);
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.filter((x) => x.status === 'granted').length === 2,
    );
    await providerUnsubscribe(profileId, t1);
    expect(await effective(profileId)).toMatchObject({ status: 'granted', allowed: true });
  });

  it('keeps a newer SDK refusal when a delayed SDK grant is processed last', async () => {
    // The SDK labels a negative action "withdrawn" when the ledger currently says granted and
    // "denied" when it already says withdrawn. Both are refusals (ADR-0014); neither may be
    // dropped because of the label, or a delayed grant outranks the later refusal.
    const anonymousId = `dev-936-refusal-${randomBytes(5).toString('hex')}`;
    const change = (at: Date, allowed: boolean) => ({
      type: 'track',
      event: 'Segment Consent Preference Updated',
      anonymousId,
      timestamp: at.toISOString(),
      context: { consent: { categoryPreferences: { marketing: allowed } } },
    });
    const initial = new Date(Date.now() - 4 * 3_600_000);
    const t0 = new Date(Date.now() - 2 * 3_600_000);
    const t1 = new Date(Date.now() - 3_600_000);
    const t2 = new Date(Date.now() - 10 * 60_000);
    await send([change(initial, true)]);
    const found = await eventually(
      () => api().call('profiles.find', { type: 'anonymous_id', value: anonymousId }),
      (r) => !!r.profileId,
    );
    const profileId = found.profileId!;
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.length === 1,
    );
    // The withdrawal at T0 becomes "withdrawn"; the later refusal at T2 (more than an hour after
    // T0) becomes "denied" because the ledger already says withdrawn.
    await send([change(t0, false)]);
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.length === 2,
    );
    await send([change(t2, false)]);
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.length === 3,
    );
    // The delayed grant is processed last.
    await send([change(t1, true)]);
    await eventually(
      () => api().call('consent.history', { profileId }),
      (r) => r.records.some((rec) => rec.recordedAt === t1.toISOString()),
    );

    expect(await effective(profileId)).toMatchObject({ status: 'denied', allowed: false });
    const records = await history(profileId);
    expect(records.find((r) => r.recordedAt === t2.toISOString())).toMatchObject({ status: 'denied', source: 'sdk' });
    expect(records.find((r) => r.recordedAt === t1.toISOString())).toMatchObject({ status: 'granted', source: 'sdk' });
  });

  it('leaves the current state, counts and export consistent with the evidence, not the row count', async () => {
    const grantedCount = async () =>
      (await api().call('consent.summary', {})).purposes.find((p) => p.purpose === 'marketing')?.granted ?? 0;
    const before = await grantedCount();
    const profileId = await newProfile();
    await handle(profileId, formEvent(profileId, new Date(Date.now() - 3 * 3_600_000)));
    await handle(profileId, formEvent(profileId, new Date(Date.now() - 60_000)));
    const records = await history(profileId);
    expect(records.filter((r) => r.status === 'granted')).toHaveLength(2);

    // The same-status evidence row does not create a second current state or count the person twice.
    const profile = await api().call('profiles.get', { profileId });
    expect(profile.consent.filter((c) => c.purpose === 'marketing' && c.channel === '')).toHaveLength(1);
    expect(profile.consentEffective.find((c) => c.purpose === 'marketing')).toMatchObject({ status: 'granted', allowed: true });
    expect((await grantedCount()) - before).toBe(1);

    // An export is the data subject's record: it carries both actions as evidence.
    const exported = await api().call('profiles.export', { profileId, maxEvents: 0 });
    expect(exported.consentRecords.filter((r) => r.status === 'granted')).toHaveLength(2);
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
