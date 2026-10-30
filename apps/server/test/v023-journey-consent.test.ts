import { readFileSync } from 'node:fs';
import { outbox } from '@agentic-marketing/email';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.2.3 (#108): people who withdraw consent for a journey's purpose leave the journey at once
// (exit reason consent_withdrawn), no later step runs, and erasure removes them from journeys.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let key: string;
let journeyId: string;

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;
const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });
const mailTo = (to: string, subject?: string) => outbox.filter((m) => m.to === to && (!subject || m.subject.includes(subject)));
const participant = async (profileId: string) => {
  const { rows } = await t.srv.db.admin.query<{ status: string; error: string | null }>(
    'SELECT status, error FROM journey_participants WHERE journey_id = $1 AND profile_id = $2',
    [journeyId, profileId],
  );
  return rows[0];
};

/** Signs a person up with consent and waits until the welcome e-mail went out. */
async function subscriber(name: string) {
  const api = t.api(owner);
  const email = `${name}-${Date.now()}@example.com`;
  await send([{ type: 'identify', userId: name, traits: { email } }]);
  const { profileId } = await eventually(
    () => api.call('profiles.find', { type: 'email', value: email }),
    (x) => !!x.profileId,
  );
  await api.call('consent.record', { profileId: profileId!, purpose: 'marketing_email', status: 'granted', proof: { test: true } });
  await send([{ type: 'track', event: 'Subscription Confirmed', userId: name }]);
  await eventually(
    async () => mailTo(email, 'Welcome'),
    (m) => m.length === 1,
  );
  await eventually(
    () => participant(profileId!),
    (p) => p?.status === 'waiting',
  );
  return { email, profileId: profileId! };
}

beforeAll(async () => {
  t = await startTestServer('test_v023_journey_consent', testPort(3313));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const template = async (name: string, subject: string) => {
    const a = await api.call('artifacts.create', {
      type: 'email_template',
      name,
      content: { purpose: 'marketing_email', subject, mjml: mjml(subject) },
    });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'Go' });
    return a.artifactId;
  };
  const welcome = await template('Welcome', 'Welcome');
  const start = await template('Start here', 'Start here');
  journeyId = (
    await api.call('artifacts.create', {
      type: 'journey',
      name: 'Newsletter welcome',
      content: {
        purpose: 'marketing_email',
        nodes: [
          { id: 'trigger', kind: 'trigger', label: 'Confirmed', config: { event: 'Subscription Confirmed', reentry: 'once' } },
          { id: 'welcome', kind: 'email', label: 'Welcome', config: { template: welcome } },
          { id: 'wait', kind: 'wait', label: 'Wait 3 days', config: { duration: 'P3D' } },
          { id: 'start', kind: 'email', label: 'Start here', config: { template: start } },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      },
    })
  ).artifactId;
  await api.call('artifacts.requestPublish', { artifactId: journeyId, note: 'Go' });
}, 60_000);
afterAll(() => t?.close());

const fastForward = () =>
  t.srv.db.admin.query(`UPDATE journey_participants SET due_at = now() WHERE journey_id = $1 AND status = 'waiting'`, [journeyId]);
/** A refusal written straight into consent_state, past the consent code (an older install, a manual fix). */
const refuseBehindTheBack = (profileId: string) =>
  t.srv.db.withWorkspace(ws, (tx) =>
    tx.execute(sql`INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
      VALUES (${ws}, ${profileId}, 'marketing_email', 'email', 'withdrawn', 'consent', 'unsubscribe', now() + interval '1 minute')`),
  );

describe('withdrawing consent during a journey', () => {
  it('a one-click unsubscribe exits the person at once, and the next e-mail is never sent', async () => {
    const api = t.api(owner);
    const ada = await subscriber('ada');
    expect(await api.call('journeys.stats', { artifactId: journeyId })).toMatchObject({ waitingAt: { wait: 1 } });

    const welcome = mailTo(ada.email, 'Welcome')[0];
    const unsubscribe = welcome.html.match(/href="([^"]*\/u\/[^"]+)"/)![1].replace(/&amp;/g, '&');
    const res = await fetch(unsubscribe, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await participant(ada.profileId)).toEqual({ status: 'exited', error: 'consent_withdrawn: marketing_email' });
    expect((await api.call('journeys.stats', { artifactId: journeyId })).waitingAt.wait ?? 0).toBe(0);

    await fastForward();
    await new Promise((r) => setTimeout(r, 1500));
    expect(mailTo(ada.email, 'Start here')).toHaveLength(0);
  });

  it('a withdrawal recorded through consent.record exits the person too', async () => {
    const bob = await subscriber('bob');
    await t.api(owner).call('consent.record', { profileId: bob.profileId, purpose: 'marketing_email', status: 'withdrawn' });
    expect(await participant(bob.profileId)).toMatchObject({ status: 'exited', error: 'consent_withdrawn: marketing_email' });
  });

  it('the sweeper exits a refused person before the next step, whatever wrote the refusal', async () => {
    const cy = await subscriber('cy');
    await refuseBehindTheBack(cy.profileId);
    expect((await participant(cy.profileId)).status).toBe('waiting');
    await fastForward();
    await eventually(
      () => participant(cy.profileId),
      (p) => p.status === 'exited',
    );
    expect((await participant(cy.profileId)).error).toBe('consent_withdrawn: marketing_email');
    expect(mailTo(cy.email, 'Start here')).toHaveLength(0);
  });

  it('people who keep their consent go on as before', async () => {
    const dee = await subscriber('dee');
    await fastForward();
    await eventually(
      async () => mailTo(dee.email, 'Start here'),
      (m) => m.length === 1,
    );
    expect(await participant(dee.profileId)).toEqual({ status: 'completed', error: null });
  });

  it('the 0.2.3 migration exits people who refused before the upgrade', async () => {
    const eve = await subscriber('eve');
    await refuseBehindTheBack(eve.profileId);
    const migration = readFileSync(new URL('../../../packages/db/migrations/0027_journey_consent_exits.sql', import.meta.url), 'utf8');
    await t.srv.db.admin.query(migration);
    expect(await participant(eve.profileId)).toEqual({ status: 'exited', error: 'consent_withdrawn: marketing_email' });
  });

  it('erasure removes the person from journeys', async () => {
    const fay = await subscriber('fay');
    await t.api(owner).call('profiles.erase', { profileId: fay.profileId, reason: 'Erasure request (test)' });
    expect(await participant(fay.profileId)).toBeUndefined();
  });
});
