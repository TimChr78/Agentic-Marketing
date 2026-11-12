import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('profiles.find writes a read audit record', async () => {
    await expectAudited('profiles.find', (api) => api.call('profiles.find', { type: 'email', value: 'v0144@example.com' }), null);
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
