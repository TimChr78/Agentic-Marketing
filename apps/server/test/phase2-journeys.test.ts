import { readFileSync } from 'node:fs';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, eventually, rejects, startTestServer, type User } from './harness';

// Phase 2 acceptance: "a welcome + abandoned-browse journey runs end-to-end, built either in the
// UI or entirely via MCP". The welcome journey is built over REST (what the UI uses); the
// abandoned-browse journey, its segment and template are built by an MCP agent.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let key: string;

beforeAll(async () => {
  t = await startTestServer('test_p2j', 3294);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'hej@shop.example.com',
    useFor: ['transactional', 'marketing'],
  });
}, 60_000);
afterAll(() => t?.close());

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });
const mailTo = (to: string, subject?: string) => outbox.filter((m) => m.to === to && (!subject || m.subject.includes(subject)));
/** Moves time forward for waiting participants, as the scheduler's clock would. */
const fastForward = (journeyId: string) =>
  t.srv.db.admin.query(`UPDATE journey_participants SET due_at = now() WHERE journey_id = $1 AND status = 'waiting'`, [journeyId]);
const mjml = (body: string, unsubscribe = true) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text>${unsubscribe ? '<mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>' : ''}</mj-column></mj-section></mj-body></mjml>`;

describe('welcome journey (REST, as the UI)', () => {
  let journeyId: string;

  it('is simulated, refused while its template is unpublished, then published', async () => {
    const api = t.api(owner);
    const welcome = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Welcome',
      content: {
        purpose: 'onboarding',
        subject: 'Welcome, {{ profile.firstName }}',
        mjml: mjml('Hej {{ profile.firstName }}, welcome!', false),
      },
    });
    const definition = {
      purpose: 'onboarding',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up', reentry: 'once' } },
        { id: 'welcome', kind: 'email', label: 'Welcome e-mail', config: { template: welcome.artifactId } },
        { id: 'wait', kind: 'wait', label: 'Wait 2 days', config: { duration: 'P2D' } },
        {
          id: 'goal',
          kind: 'goal',
          label: 'First order',
          config: { event: 'Order Completed', within: 'P14D' },
          next: [{ to: 'done' }, { to: 'done' }],
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    } as const;
    journeyId = (await api.call('artifacts.create', { type: 'journey', name: 'Welcome', content: definition })).artifactId;

    const sim = await api.call('journeys.simulate', { artifactId: journeyId, events: [{ event: 'Order Completed', after: 'P3D' }] });
    expect(sim).toMatchObject({ outcome: 'completed', converted: true });
    expect(sim.steps.map((s) => `${s.after} ${s.node}`)).toEqual(['0m trigger', '0m welcome', '0m wait', '2d goal', '3d goal', '3d done']);

    const refused = await rejects(api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'Go' }));
    expect(refused.message).toContain('is not a published e-mail template');
    await api.call('artifacts.requestPublish', { artifactId: welcome.artifactId, note: 'Go' });
    await api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'Go' });
  });

  it('enters on the trigger event, sends at once, waits, and converts on the goal event', async () => {
    const api = t.api(owner);
    await send([
      { type: 'identify', userId: 'ada', traits: { email: 'ada@example.com', firstName: 'Ada' } },
      { type: 'track', event: 'Signed Up', userId: 'ada' },
    ]);
    const mail = await eventually(
      async () => mailTo('ada@example.com', 'Welcome'),
      (m) => m.length === 1,
    );
    expect(mail[0].subject).toBe('Welcome, Ada');
    expect(mail[0].stream).toBe('transactional');
    expect(mail[0].headers['List-Unsubscribe']).toBeUndefined();
    expect(await api.call('journeys.stats', { artifactId: journeyId })).toMatchObject({ now: { waiting: 1 }, waitingAt: { wait: 1 } });

    // Signing up again does not enter twice (re-entry "once").
    await send([{ type: 'track', event: 'Signed Up', userId: 'ada' }]);

    await fastForward(journeyId);
    await eventually(
      () => api.call('journeys.stats', { artifactId: journeyId }),
      (s) => s.waitingAt.goal === 1,
    );
    await send([{ type: 'track', event: 'Order Completed', userId: 'ada', properties: { total: 899 } }]);
    const done = await eventually(
      () => api.call('journeys.stats', { artifactId: journeyId }),
      (s) => s.now.completed === 1,
    );
    expect(done.now).toMatchObject({ completed: 1, exited: 0, converted: 1, waiting: 0, ready: 0 });
    expect(mailTo('ada@example.com', 'Welcome')).toHaveLength(1);
    const reached = await eventually(
      () => api.call('journeys.stats', { artifactId: journeyId }),
      (s) => (s.reached.done ?? 0) === 1,
    );
    expect(reached.reached).toMatchObject({ trigger: 1, welcome: 1, goal: 1, done: 1 });
  });

  it('the 0.2.10 migration relabels people who ended at an Exit step before the fix (#169)', async () => {
    // Before 0.2.10 an Exit step stored `exited` with no error; an early exit always has one.
    await t.srv.db.admin.query(`UPDATE journey_participants SET status = 'exited' WHERE journey_id = $1`, [journeyId]);
    const migration = readFileSync(
      new URL('../../../packages/db/migrations/0044_journey_exit_step_completed.sql', import.meta.url),
      'utf8',
    );
    await t.srv.db.admin.query(migration);
    expect((await t.api(owner).call('journeys.stats', { artifactId: journeyId })).now).toMatchObject({ completed: 1, exited: 0 });
  });
});

describe('abandoned browse (built by an MCP agent)', () => {
  it('runs from segment entry to the reminder, and respects consent', async () => {
    const agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'profiles:read']);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await agent.client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: any;
        content: { text: string }[];
      };
      if (r.isError) throw new Error(r.content[0].text);
      return r.structuredContent;
    };
    try {
      const tools = (await agent.client.listTools()).tools.map((x) => x.name);
      expect(tools).toEqual(expect.arrayContaining(['segments.preview', 'journeys.simulate', 'templates.preview', 'artifacts.create']));
      expect(tools).not.toContain('emailProviders.create');

      const segment = await call('artifacts.create', {
        type: 'segment',
        name: 'Browsed tents, no order',
        content: {
          condition: {
            all: [
              { event: 'Product Viewed', where: { category: 'tents' }, count: { gte: 2 }, within: 'P7D' },
              { event: 'Order Completed', count: { lte: 0 }, within: 'P7D' },
            ],
          },
        },
      });
      const template = await call('artifacts.create', {
        type: 'email_template',
        name: 'Still thinking about tents?',
        content: {
          purpose: 'marketing_email',
          subject: 'Still thinking about tents, {{ profile.firstName }}?',
          mjml: mjml('Your tent is waiting.'),
        },
      });
      const journey = await call('artifacts.create', {
        type: 'journey',
        name: 'Abandoned browse',
        content: {
          purpose: 'marketing_email',
          nodes: [
            { id: 'trigger', kind: 'trigger', label: 'Browsed tents', config: { segment: segment.artifactId, reentry: 'after_exit' } },
            {
              id: 'wait',
              kind: 'waitEvent',
              label: 'Ordered within 1 hour?',
              config: { event: 'Order Completed', timeout: 'PT1H' },
              next: [{ to: 'done' }, { to: 'remind' }],
            },
            { id: 'remind', kind: 'email', label: 'Reminder', config: { template: template.artifactId } },
            { id: 'done', kind: 'exit', label: 'Done', config: {} },
          ],
        },
      });
      for (const a of [segment, template, journey])
        expect(await call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'Abandoned browse' })).toMatchObject({
          status: 'published',
        });

      // Bo agreed to marketing e-mail; Cy did not.
      const consent = (userId: string, yes: boolean) => ({
        type: 'track',
        event: 'Segment Consent Preference Updated',
        userId,
        context: { consent: { categoryPreferences: { marketing_email: yes } } },
      });
      const browse = (userId: string) =>
        [1, 2].map(() => ({ type: 'track', event: 'Product Viewed', userId, properties: { category: 'tents' } }));
      await send([
        { type: 'identify', userId: 'bo', traits: { email: 'bo@example.com', firstName: 'Bo' } },
        consent('bo', true),
        { type: 'identify', userId: 'cy', traits: { email: 'cy@example.com', firstName: 'Cy' } },
        consent('cy', false),
      ]);
      await new Promise((r) => setTimeout(r, 1500));
      await send([...browse('bo'), ...browse('cy')]);

      // Cy refused marketing e-mail, the journey's purpose, so leaves before any step (0.2.3, #108).
      const stats = await eventually(
        () => call('journeys.stats', { artifactId: journey.artifactId }),
        (s) => s.waitingAt?.wait === 1 && s.now.exited === 1,
      );
      expect(stats.now.waiting).toBe(1);

      await fastForward(journey.artifactId);
      await eventually(
        () => call('journeys.stats', { artifactId: journey.artifactId }),
        (s) => s.now.completed === 1,
      );
      const mail = await eventually(
        async () => mailTo('bo@example.com', 'tents'),
        (m) => m.length === 1,
      );
      expect(mail[0].subject).toBe('Still thinking about tents, Bo?');
      expect(mail[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(mailTo('cy@example.com')).toHaveLength(0);

      const owners = t.api(owner);
      const cy = (await owners.call('profiles.find', { type: 'user_id', value: 'cy' })).profileId!;
      expect((await owners.call('messages.list', { profileId: cy })).messages).toHaveLength(0);

      // The agent can explain the path a given person would take.
      const sim = await call('journeys.simulate', { artifactId: journey.artifactId, profileId: cy });
      expect(sim.steps.find((s: { node: string }) => s.node === 'remind').detail).toContain('would not send: no_lawful_basis');
      expect(ws).toBeTruthy();
    } finally {
      await agent.client.close();
    }
  });
});
