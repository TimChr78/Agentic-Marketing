import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// 0.14.11 privacy fixes from the 0.14.8 audit.
//   #762 journeys.simulate with a person must be gated at profiles:read, not artifacts:read.
//   #763 a read's audit row must name the people it resolved, sampled or listed.
//   #765 national-format phone numbers and addresses must be withheld from consent proof.

const PURPOSES = {
  purposes: [
    {
      key: 'marketing',
      name: 'Marketing',
      description: 'News and offers by e-mail.',
      basis: 'consent',
      channels: ['email'],
      requiresDoubleOptIn: false,
      topics: [],
    },
  ],
};

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let marketer: User;
let viewer: User;
let ws: string;
let key: string;
let ada: string;
let bo: string;
let journeyId: string;
let piiJourneyId: string;

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const profileOf = async (userId: string) =>
  (
    await eventually(
      () => t.api(owner, ws).call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;

beforeAll(async () => {
  t = await startTestServer('test_v01411_privacy', testPort(4402));
  owner = await t.signUp(`privacy-owner-${Date.now()}@example.com`);
  marketer = await t.signUp(`privacy-marketer-${Date.now()}@example.com`);
  viewer = await t.signUp(`privacy-viewer-${Date.now()}@example.com`);
  ws = await t.workspaceWith(
    [
      [owner, 'owner'],
      [marketer, 'marketer'],
      [viewer, 'viewer'],
    ],
    'none',
  );
  const api = t.api(owner, ws);
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;

  const purposes = await api.call('artifacts.create', { type: 'purposes', name: 'Purposes', content: PURPOSES });
  await api.call('artifacts.requestPublish', { artifactId: purposes.artifactId, note: 'test' });

  await send([
    { type: 'identify', userId: 'v01411-ada', traits: { email: 'ada-v01411@example.com', city: 'Aarhus' } },
    { type: 'identify', userId: 'v01411-bo', traits: { email: 'bo-v01411@example.com', city: 'Odense' } },
  ]);
  ada = await profileOf('v01411-ada');
  bo = await profileOf('v01411-bo');

  const template = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Privacy',
    content: {
      purpose: 'marketing',
      subject: 'Hej',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
    },
  });
  await api.call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'test' });
  // Two messages about two people, so an unfiltered list spans more than one.
  await api.call('messages.sendEmail', { profileId: ada, templateId: template.artifactId, idempotencyKey: 'privacy-ada' });
  await api.call('messages.sendEmail', { profileId: bo, templateId: template.artifactId, idempotencyKey: 'privacy-bo' });

  journeyId = (
    await api.call('artifacts.create', {
      type: 'journey',
      name: 'Privacy preview',
      content: {
        purpose: 'marketing',
        nodes: [
          { id: 'start', kind: 'trigger', label: 'Started', config: { event: 'V01411 Started' } },
          { id: 'mail', kind: 'email', label: 'Send', config: { template: template.artifactId }, next: [{ to: 'done' }] },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      },
    })
  ).artifactId;
  await api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'test' });

  // A step whose detail carries personal data from the journey content (a phone number here).
  piiJourneyId = (
    await api.call('artifacts.create', {
      type: 'journey',
      name: 'Trait preview',
      content: {
        purpose: 'marketing',
        nodes: [
          { id: 'start', kind: 'trigger', label: 'Started', config: { event: 'V01411 Trait' } },
          {
            id: 'set',
            kind: 'updateProfile',
            label: 'Remember the callback number',
            config: { trait: 'callback_phone', value: '555 123 4567' },
            next: [{ to: 'done' }],
          },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      },
    })
  ).artifactId;
}, 60_000);

afterAll(() => t?.close());

describe('journeys.simulate is gated by the person it walks (#762)', () => {
  it('refuses a viewer with only artifacts:read when a profileId is given', async () => {
    const error = await rejects(t.api(viewer, ws).call('journeys.simulate', { artifactId: journeyId, profileId: ada }));
    expect(error).toMatchObject({ code: 'forbidden' });
    expect(error.message).toContain('profiles:read');
    // Nothing about the person came back.
    expect(JSON.stringify(error)).not.toContain(ada);
  });

  it('allows the same viewer to dry-run without a profileId', async () => {
    const sim = await t.api(viewer, ws).call('journeys.simulate', { artifactId: journeyId });
    expect(sim.steps.map((s) => s.node)).toContain('mail');
    expect(sim.steps.find((s) => s.node === 'mail')!.detail).toContain('would send');
  });

  it('lets a role with profiles:read see the person’s walk as before', async () => {
    const sim = await t.api(marketer, ws).call('journeys.simulate', { artifactId: journeyId, profileId: ada });
    const mail = sim.steps.find((s) => s.node === 'mail')!;
    expect(mail.detail).toContain('would not send');
    expect(mail.detail).toContain('no_lawful_basis');
  });

  it('withholds a step that would show personal data from a role without profiles:pii', async () => {
    const detailOf = (sim: { steps: { node: string; detail: string }[] }) => sim.steps.find((s) => s.node === 'set')!.detail;
    const asMarketer = await t.api(marketer, ws).call('journeys.simulate', { artifactId: piiJourneyId, profileId: ada });
    expect(detailOf(asMarketer)).not.toContain('555 123 4567');
    expect(detailOf(asMarketer)).toContain('profiles:pii');
    const asOwner = await t.api(owner, ws).call('journeys.simulate', { artifactId: piiJourneyId, profileId: ada });
    expect(detailOf(asOwner)).toContain('555 123 4567');
  });
});

describe('audited reads record the people they reached (#763)', () => {
  it('audit.list names the person a profiles.find resolved', async () => {
    const found = await t.api(marketer, ws).call('profiles.find', { type: 'user_id', value: 'v01411-ada' });
    expect(found.profileId).toBe(ada);
    const { entries } = await t.api(owner, ws).call('audit.list', { target: ada, limit: 50 });
    expect(entries[0]).toMatchObject({ command: 'profiles.find', target: ada, ok: true });
  });

  it('audit.list names each person a segments.preview sampled', async () => {
    const preview = await t.api(marketer, ws).call('segments.preview', {
      condition: { trait: 'city', op: 'eq', value: 'Aarhus' },
    });
    expect(preview.sample).toContain(ada);
    for (const id of preview.sample) {
      const { entries } = await t.api(owner, ws).call('audit.list', { target: id, limit: 100 });
      expect(
        entries.some((e) => e.command === 'segments.preview'),
        id,
      ).toBe(true);
    }
  });

  it('audit.list names every person an unfiltered messages.list returned', async () => {
    const list = await t.api(marketer, ws).call('messages.list', { limit: 50 });
    const people = [...new Set(list.messages.map((m) => m.profileId).filter((id): id is string => !!id))];
    expect(people).toEqual(expect.arrayContaining([ada, bo]));
    for (const id of people) {
      const { entries } = await t.api(owner, ws).call('audit.list', { target: id, limit: 100 });
      expect(
        entries.some((e) => e.command === 'messages.list'),
        id,
      ).toBe(true);
    }
  });
});

describe('consent proof withholds national phones and addresses (#765)', () => {
  beforeAll(async () => {
    const api = t.api(owner, ws);
    await api.call('consent.record', {
      profileId: ada,
      purpose: 'marketing',
      status: 'granted',
      source: 'api',
      proof: { via: 'called back on 555 123 4567', method: 'signed at 123 Main Street', system: 'Kit' },
    });
  });

  it('withholds them from consent.history for a role without profiles:pii', async () => {
    const history = await t.api(marketer, ws).call('consent.history', { profileId: ada });
    const record = history.records.at(-1)!;
    expect(record.proofWithheld).toBe(true);
    expect(record.proof).toEqual({ system: 'Kit' });
    expect(JSON.stringify(history)).not.toContain('555 123 4567');
    expect(JSON.stringify(history)).not.toContain('123 Main Street');
  });

  it('shows them to a role with profiles:pii', async () => {
    const history = await t.api(owner, ws).call('consent.history', { profileId: ada });
    const record = history.records.at(-1)!;
    expect(record.proofWithheld).toBe(false);
    expect(record.proof).toMatchObject({ via: 'called back on 555 123 4567', method: 'signed at 123 Main Street' });
  });
});
