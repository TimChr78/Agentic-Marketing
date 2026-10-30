import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, type User } from './harness';

// 0.2.8 (#92, #93): wait until a condition matches, and business entry keys for event triggers.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let key: string;
let welcomeTemplate: string;

const mjml = (body: string) => `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const api = () => t.api(owner);
const mailTo = (to: string) => outbox.filter((m) => m.to === to);
const profileIdOf = async (userId: string) =>
  (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;
const traitsOf = async (profileId: string) =>
  (await t.srv.db.admin.query<{ traits: Record<string, unknown> }>('SELECT traits FROM profiles WHERE id = $1', [profileId])).rows[0]
    ?.traits ?? {};

interface Row {
  id: string;
  status: string;
  node: string;
  entry_key: string;
  waiting_until: string | null;
  due_at: string | null;
}
const rowsOf = async (journeyId: string, profileId?: string) =>
  (
    await t.srv.db.admin.query<Row>(
      `SELECT id::text, status, node, entry_key, waiting_until, due_at FROM journey_participants
       WHERE journey_id = $1 ${profileId ? 'AND profile_id = $2' : ''} ORDER BY id`,
      profileId ? [journeyId, profileId] : [journeyId],
    )
  ).rows;
const rowOf = async (journeyId: string, profileId: string) => (await rowsOf(journeyId, profileId))[0];

/** Moves a participant past any waiting step, as the scheduler's clock would. */
const fastForward = (journeyId: string, profileId: string) =>
  t.srv.db.admin.query(`UPDATE journey_participants SET due_at = now() WHERE journey_id = $1 AND profile_id = $2 AND status = 'waiting'`, [
    journeyId,
    profileId,
  ]);

/** Makes a waitUntil's deadline pass now. */
const expire = (journeyId: string, profileId: string) =>
  t.srv.db.admin.query(
    `UPDATE journey_participants SET due_at = now(), waiting_until = now() - interval '1 second'
     WHERE journey_id = $1 AND profile_id = $2 AND status = 'waiting'`,
    [journeyId, profileId],
  );

async function createJourney(name: string, content: Record<string, unknown>) {
  const a = await api().call('artifacts.create', { type: 'journey', name, content: content as never });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

/** A journey that marks which waitUntil outcome it took in the profile's `last_path` trait. */
const waitJourney = (name: string, wait: Record<string, unknown>, purpose = 'onboarding') =>
  createJourney(name, {
    purpose,
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Wait Start', reentry: 'once' } },
      { id: 'wait', kind: 'waitUntil', label: 'Wait for it', config: wait, next: [{ to: 'matched' }, { to: 'timeout' }] },
      { id: 'matched', kind: 'updateProfile', label: 'Matched', config: { trait: 'last_path', value: 'matched' }, next: [{ to: 'done' }] },
      {
        id: 'timeout',
        kind: 'updateProfile',
        label: 'Timed out',
        config: { trait: 'last_path', value: 'timeout' },
        next: [{ to: 'done' }],
      },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ],
  });

beforeAll(async () => {
  t = await startTestServer('test_v028_nodes', 3314);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await api().call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'hello@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const template = await api().call('artifacts.create', {
    type: 'email_template',
    name: 'Matched',
    content: { purpose: 'onboarding', subject: 'You matched', mjml: mjml('Matched') },
  });
  welcomeTemplate = template.artifactId;
  await api().call('artifacts.requestPublish', { artifactId: welcomeTemplate, note: 'test' });
}, 60_000);
afterAll(() => t?.close());

describe('waitUntil (#92)', () => {
  it('matches immediately when the condition is already true', async () => {
    const userId = 'wait-now';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com`, plan: 'pro' } }]);
    const journeyId = await waitJourney('Wait now', {
      condition: { trait: 'plan', op: 'eq', value: 'pro' },
      timeout: 'P14D',
      recheck: 'PT1H',
    });
    const profileId = await profileIdOf(userId);
    await send([{ type: 'track', event: 'Wait Start', userId }]);
    const row = await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'completed',
    );
    expect(row?.node).toBe('done');
    expect((await traitsOf(profileId)).last_path).toBe('matched');
    expect(row?.waiting_until).toBeNull();
  });

  it('matches later on an identify, without waiting for the sweeper', async () => {
    const userId = 'wait-identify';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com`, plan: 'free' } }]);
    const journeyId = await waitJourney('Wait identify', {
      condition: { trait: 'plan', op: 'eq', value: 'pro' },
      timeout: 'P14D',
      recheck: 'PT1H',
    });
    const profileId = await profileIdOf(userId);
    await send([{ type: 'track', event: 'Wait Start', userId }]);
    const waiting = await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'waiting',
    );
    expect(waiting?.node).toBe('wait');
    expect(waiting?.waiting_until).not.toBeNull();
    // The recheck is an hour away; only the identify event can move this participant now.
    await send([{ type: 'identify', userId, traits: { plan: 'pro' } }]);
    const matched = await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'completed',
    );
    expect((await traitsOf(profileId)).last_path).toBe('matched');
    expect(matched?.node).toBe('done');
  });

  it('matches when the person enters a segment', async () => {
    const segment = await api().call('artifacts.create', {
      type: 'segment',
      name: 'VIP for waitUntil',
      content: { condition: { trait: 'vip', op: 'eq', value: true } },
    });
    await api().call('artifacts.requestPublish', { artifactId: segment.artifactId, note: 'test' });
    const userId = 'wait-segment';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com`, vip: false } }]);
    const journeyId = await waitJourney('Wait segment', { condition: { segment: segment.artifactId }, timeout: 'P14D', recheck: 'PT1H' });
    const profileId = await profileIdOf(userId);
    await send([{ type: 'track', event: 'Wait Start', userId }]);
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'waiting',
    );
    await send([{ type: 'identify', userId, traits: { vip: true } }]);
    const matched = await eventually(
      () => rowsOf(journeyId, profileId),
      (rows) => rows[0]?.status === 'completed',
      15_000,
    );
    expect(matched[0]?.node).toBe('done');
    expect((await traitsOf(profileId)).last_path).toBe('matched');
  });

  it('takes the timeout path when the deadline passes', async () => {
    const userId = 'wait-timeout';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com`, plan: 'free' } }]);
    const journeyId = await waitJourney('Wait timeout', {
      condition: { trait: 'plan', op: 'eq', value: 'pro' },
      timeout: 'PT1H',
      recheck: 'PT5M',
    });
    const profileId = await profileIdOf(userId);
    await send([{ type: 'track', event: 'Wait Start', userId }]);
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'waiting',
    );
    await expire(journeyId, profileId);
    const timedOut = await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'completed',
    );
    expect(timedOut?.node).toBe('done');
    expect((await traitsOf(profileId)).last_path).toBe('timeout');
    expect(timedOut?.waiting_until).toBeNull();
  });

  it('advances exactly once when two matching events arrive together', async () => {
    const userId = 'wait-two';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const journeyId = await createJourney('Wait two events', {
      purpose: 'onboarding',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Wait Start', reentry: 'once' } },
        {
          id: 'wait',
          kind: 'waitUntil',
          label: 'Until ordered',
          config: { condition: { event: 'Order Completed', count: { gte: 1 } }, timeout: 'P1D', recheck: 'PT1H' },
          next: [{ to: 'mail' }, { to: 'done' }],
        },
        { id: 'mail', kind: 'email', label: 'Matched', config: { template: welcomeTemplate }, next: [{ to: 'done' }] },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const profileId = await profileIdOf(userId);
    await send([{ type: 'track', event: 'Wait Start', userId }]);
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'waiting',
    );
    await send([
      { type: 'track', event: 'Order Completed', userId, properties: { order_id: 'two-1' } },
      { type: 'track', event: 'Order Completed', userId, properties: { order_id: 'two-2' } },
    ]);
    await eventually(
      async () => mailTo(`${userId}@example.com`),
      (m) => m.length >= 1,
    );
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'completed',
    );
    await new Promise((r) => setTimeout(r, 750));
    expect(mailTo(`${userId}@example.com`)).toHaveLength(1);
  });

  it('cancels the wait when the person exits the journey', async () => {
    const userId = 'wait-exit';
    const profileId = await (async () => {
      await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com`, plan: 'free' } }]);
      return profileIdOf(userId);
    })();
    await api().call('consent.record', { profileId, purpose: 'marketing_email', status: 'granted', proof: { test: true } });
    const journeyId = await waitJourney(
      'Wait exit',
      { condition: { trait: 'plan', op: 'eq', value: 'pro' }, timeout: 'P14D', recheck: 'PT1H' },
      'marketing_email',
    );
    await send([{ type: 'track', event: 'Wait Start', userId }]);
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'waiting',
    );
    await api().call('consent.record', { profileId, purpose: 'marketing_email', status: 'withdrawn', proof: { test: true } });
    const exited = await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'exited',
    );
    expect(exited?.due_at).toBeNull();
    expect(exited?.waiting_until).toBeNull();
    // A later matching event cannot wake someone who left.
    await send([{ type: 'identify', userId, traits: { plan: 'pro' } }]);
    await new Promise((r) => setTimeout(r, 750));
    expect((await rowOf(journeyId, profileId))?.status).toBe('exited');
    expect(await traitsOf(profileId)).not.toHaveProperty('last_path');
  });

  it('rejects a timeout beyond 90 days and a recheck below 5 minutes', async () => {
    const create = (config: Record<string, unknown>) =>
      api().call('artifacts.create', {
        type: 'journey',
        name: 'Invalid wait',
        content: {
          purpose: 'onboarding',
          nodes: [
            { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Wait Start', reentry: 'once' } },
            { id: 'wait', kind: 'waitUntil', label: 'Wait', config },
            { id: 'done', kind: 'exit', label: 'Done', config: {} },
          ],
        },
      });
    const long = await create({ condition: { trait: 'plan', op: 'eq', value: 'pro' }, timeout: 'P91D', recheck: 'PT1H' });
    await expect(api().call('artifacts.requestPublish', { artifactId: long.artifactId, note: 'test' })).rejects.toThrow(/at most P90D/);
    const often = await create({ condition: { trait: 'plan', op: 'eq', value: 'pro' }, timeout: 'P14D', recheck: 'PT1M' });
    await expect(api().call('artifacts.requestPublish', { artifactId: often.artifactId, note: 'test' })).rejects.toThrow(/at least PT5M/);
  });

  it('simulates matched now and would wait', async () => {
    const journeyId = await waitJourney('Wait simulation', {
      condition: { trait: 'plan', op: 'eq', value: 'pro' },
      timeout: 'P14D',
      recheck: 'PT1H',
    });
    await send([{ type: 'identify', userId: 'sim-pro', traits: { email: 'sim-pro@example.com', plan: 'pro' } }]);
    await send([{ type: 'identify', userId: 'sim-free', traits: { email: 'sim-free@example.com', plan: 'free' } }]);
    const pro = await api().call('journeys.simulate', { artifactId: journeyId, profileId: await profileIdOf('sim-pro') });
    expect(pro.steps.find((s) => s.node === 'wait')?.detail).toContain('matched now');
    const free = await api().call('journeys.simulate', { artifactId: journeyId, profileId: await profileIdOf('sim-free') });
    expect(free.steps.find((s) => s.node === 'wait')?.detail).toContain('would wait until');
    expect(free.steps.map((s) => s.node)).toContain('timeout');
  });
});

describe('entry keys (#93)', () => {
  it('enters once for the same order_id and reports the duplicate', async () => {
    const journeyId = await createJourney('Orders by id', {
      purpose: 'onboarding',
      nodes: [
        {
          id: 'trigger',
          kind: 'trigger',
          label: 'Order placed',
          config: { event: 'Order Placed', reentry: 'once', entryKey: { source: 'event_property', property: 'order_id' } },
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const userId = 'orders-same';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const profileId = await profileIdOf(userId);
    await send([
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'A-1' } },
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'A-1' } },
    ]);
    const rows = await eventually(
      () => rowsOf(journeyId, profileId),
      (r) => r.length > 0,
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowsOf(journeyId, profileId)).toHaveLength(1);
    expect(rows[0]?.entry_key).toBe('prop:order_id:A-1');
    expect(await api().call('journeys.stats', { artifactId: journeyId })).toMatchObject({ duplicatesSkipped: 1, missingKeySkipped: 0 });
    const sim = await api().call('journeys.simulate', {
      artifactId: journeyId,
      sampleEvent: { name: 'Order Placed', properties: { order_id: 'A-1' } },
    });
    expect(sim.entry).toMatchObject({ key: 'prop:order_id:A-1', source: 'event_property', duplicate: true });
  });

  it('enters twice for two different order_id values', async () => {
    const journeyId = await createJourney('Orders by different id', {
      purpose: 'onboarding',
      nodes: [
        {
          id: 'trigger',
          kind: 'trigger',
          label: 'Order placed',
          config: { event: 'Order Placed', reentry: 'once', entryKey: { source: 'event_property', property: 'order_id' } },
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const userId = 'orders-different';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const profileId = await profileIdOf(userId);
    await send([
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'B-1' } },
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'B-2' } },
    ]);
    const rows = await eventually(
      () => rowsOf(journeyId, profileId),
      (r) => r.length === 2,
    );
    expect(rows.map((r) => r.entry_key).sort()).toEqual(['prop:order_id:B-1', 'prop:order_id:B-2']);
  });

  it('skips a missing key, or falls back to the message id when configured', async () => {
    const skipId = await createJourney('Missing key skip', {
      purpose: 'onboarding',
      nodes: [
        {
          id: 'trigger',
          kind: 'trigger',
          label: 'Order placed',
          config: {
            event: 'Order Placed',
            reentry: 'once',
            entryKey: { source: 'event_property', property: 'order_id', onMissing: 'skip' },
          },
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const fallbackId = await createJourney('Missing key fallback', {
      purpose: 'onboarding',
      nodes: [
        {
          id: 'trigger',
          kind: 'trigger',
          label: 'Order placed',
          config: {
            event: 'Order Placed',
            reentry: 'once',
            entryKey: { source: 'event_property', property: 'order_id', onMissing: 'message_id' },
          },
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const userId = 'orders-missing';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const profileId = await profileIdOf(userId);
    await send([{ type: 'track', event: 'Order Placed', userId, properties: {} }]);
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowsOf(skipId, profileId)).toHaveLength(0);
    const fallback = await eventually(
      () => rowsOf(fallbackId, profileId),
      (r) => r.length === 1,
    );
    expect(fallback[0]?.entry_key).toMatch(/^[0-9a-z-]{8,}$/i);
    expect(fallback[0]?.entry_key.startsWith('prop:')).toBe(false);
    expect(await api().call('journeys.stats', { artifactId: skipId })).toMatchObject({ missingKeySkipped: 1, duplicatesSkipped: 0 });
    const sim = await api().call('journeys.simulate', {
      artifactId: skipId,
      sampleEvent: { name: 'Order Placed', properties: {} },
    });
    expect(sim.entry).toMatchObject({ key: null, duplicate: false });
    expect(sim.entry?.note).toContain('missing');
  });

  it('after_exit allows the same key again only after the first participant left', async () => {
    const journeyId = await createJourney('Orders after exit', {
      purpose: 'onboarding',
      nodes: [
        {
          id: 'trigger',
          kind: 'trigger',
          label: 'Order placed',
          config: { event: 'Order Placed', reentry: 'after_exit', entryKey: { source: 'event_property', property: 'order_id' } },
        },
        { id: 'wait', kind: 'wait', label: 'Wait a day', config: { duration: 'P1D' }, next: [{ to: 'done' }] },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const userId = 'orders-after-exit';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const profileId = await profileIdOf(userId);
    await send([
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'C-1' } },
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'C-1' } },
    ]);
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'waiting',
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowsOf(journeyId, profileId)).toHaveLength(1);
    expect(await api().call('journeys.stats', { artifactId: journeyId })).toMatchObject({ duplicatesSkipped: 1 });
    await fastForward(journeyId, profileId);
    await eventually(
      () => rowOf(journeyId, profileId),
      (r) => r?.status === 'completed',
    );
    await send([{ type: 'track', event: 'Order Placed', userId, properties: { order_id: 'C-1' } }]);
    const rows = await eventually(
      () => rowsOf(journeyId, profileId),
      (r) => r.length === 2,
    );
    expect(rows.map((r) => r.entry_key)).toEqual(['prop:order_id:C-1', 'prop:order_id:C-1']);
  });

  it('keeps the message-id and profile behaviour when no entry key is configured', async () => {
    const journeyId = await createJourney('Default entry key', {
      purpose: 'onboarding',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Order placed', config: { event: 'Order Placed', reentry: 'once' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const userId = 'orders-default';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const profileId = await profileIdOf(userId);
    await send([
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'D-1' } },
      { type: 'track', event: 'Order Placed', userId, properties: { order_id: 'D-2' } },
    ]);
    await eventually(
      () => rowsOf(journeyId, profileId),
      (r) => r.length > 0,
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowsOf(journeyId, profileId)).toHaveLength(1);
    expect(await api().call('journeys.stats', { artifactId: journeyId })).toMatchObject({ duplicatesSkipped: 0, missingKeySkipped: 0 });
  });

  it('rejects an event_property key without a property', async () => {
    const a = await api().call('artifacts.create', {
      type: 'journey',
      name: 'Bad entry key',
      content: {
        purpose: 'onboarding',
        nodes: [
          {
            id: 'trigger',
            kind: 'trigger',
            label: 'Start',
            config: { event: 'Wait Start', reentry: 'once', entryKey: { source: 'event_property' } },
          },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      },
    });
    await expect(api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' })).rejects.toThrow(
      /property is required/,
    );
  });
});
