import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { createClient } from '@agentic-marketing/client';
import { evaluate, materialize } from '@agentic-marketing/segments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// 0.2.8 (#84): topics under purposes, topic gating in the send gateway and segment evaluators,
// the hosted preference centre and the topic unsubscribe link.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
const ids = { newsletter: '', product: '', transactional: '', segment: '' };
const people = new Map<string, string>();

const api = () => t.api(owner);
const publish = async (artifactId: string) => api().call('artifacts.requestPublish', { artifactId, note: 'test' });

const mjml = `<mjml><mj-body><mj-section><mj-column>
  <mj-text>Hello {{ profile.firstName | default: 'there' }}</mj-text>
  <mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a> · <a href="{{ preferences_url }}">Preferences</a></mj-text>
</mj-column></mj-section></mj-body></mjml>`;

const purposesContent = {
  purposes: DEFAULT_PURPOSES.map((p) => {
    if (p.key === 'marketing_email')
      return {
        ...p,
        topics: [
          { key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' as const },
          { key: 'product_news', name: 'Product news', description: 'Launches and changes', default: 'unsubscribed' as const },
        ],
      };
    if (p.key === 'onboarding')
      return {
        ...p,
        topics: [{ key: 'service_notes', name: 'Service notes', description: 'Account and order mail', default: 'unsubscribed' as const }],
      };
    return p;
  }),
};

beforeAll(async () => {
  t = await startTestServer('test_v028_topics', testPort(3470));
  owner = await t.signUp(`topics-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const a = api();

  const purposes = await a.call('artifacts.create', { type: 'purposes', name: 'Purposes', content: purposesContent });
  await publish(purposes.artifactId);

  await a.call('emailProviders.create', {
    name: 'Log',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });

  const newsletter = await a.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly newsletter',
    content: { purpose: 'marketing_email', topic: 'newsletter', subject: 'The Friday issue', mjml },
  });
  await publish(newsletter.artifactId);
  ids.newsletter = newsletter.artifactId;

  const product = await a.call('artifacts.create', {
    type: 'email_template',
    name: 'Product news',
    content: { purpose: 'marketing_email', topic: 'product_news', subject: 'Product news', mjml },
  });
  await publish(product.artifactId);
  ids.product = product.artifactId;

  const transactional = await a.call('artifacts.create', {
    type: 'email_template',
    name: 'Order update',
    content: { purpose: 'onboarding', topic: 'service_notes', subject: 'Your order', mjml },
  });
  await publish(transactional.artifactId);
  ids.transactional = transactional.artifactId;

  const segment = await a.call('artifacts.create', {
    type: 'segment',
    name: 'Newsletter readers',
    content: { condition: { topic: 'newsletter' } },
  });
  await publish(segment.artifactId);
  ids.segment = segment.artifactId;

  await a.call('profiles.import', {
    label: 'Topics test',
    rows: ['ada', 'bo', 'cy', 'dee', 'eve'].map((name) => ({
      email: `${name}@example.com`,
      traits: { firstName: name },
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  for (const name of ['ada', 'bo', 'cy', 'dee', 'eve']) {
    const found = await eventually(
      () => a.call('profiles.find', { type: 'email', value: `${name}@example.com` }),
      (r) => !!r.profileId,
    );
    people.set(name, found.profileId!);
    await eventually(
      () => a.call('profiles.get', { profileId: found.profileId! }),
      (p) => p.consent.length > 0,
    );
  }
}, 90_000);

afterAll(() => t?.close());

const send = (name: string, templateId: string) => api().call('messages.sendEmail', { profileId: people.get(name)!, templateId });

describe('topics in the send gateway (#84)', () => {
  it('sends while the topic default is subscribed, then suppresses after an unsubscribe', async () => {
    expect(await send('ada', ids.newsletter)).toMatchObject({ status: 'queued' });
    expect(
      await api().call('topics.set', { profileId: people.get('ada')!, topic: 'newsletter', status: 'unsubscribed', note: 'test' }),
    ).toMatchObject({
      recorded: true,
      purpose: 'marketing_email',
      status: 'unsubscribed',
    });
    const blocked = await send('ada', ids.newsletter);
    expect(blocked).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('topic_unsubscribed') });
  });

  it('suppresses a default-unsubscribed topic until the person subscribes', async () => {
    expect(await send('cy', ids.product)).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('topic_unsubscribed') });
    await api().call('topics.set', { profileId: people.get('cy')!, topic: 'product_news', status: 'subscribed' });
    expect(await send('cy', ids.product)).toMatchObject({ status: 'queued' });
  });

  it('never topic-gates a transactional purpose', async () => {
    expect(await send('dee', ids.transactional)).toMatchObject({ status: 'queued' });
  });

  it('refuses a topic that belongs to another purpose when publishing', async () => {
    const wrong = await api().call('artifacts.create', {
      type: 'email_template',
      name: 'Wrong topic',
      content: {
        purpose: 'onboarding',
        topic: 'newsletter',
        subject: 'x',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>x</mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    });
    const e = await rejects(api().call('artifacts.requestPublish', { artifactId: wrong.artifactId, note: 'x' }));
    expect(e.message).toContain('belongs to purpose "marketing_email"');
  });
});

describe('topic segment condition (#84)', () => {
  it('gives the same members in the streaming (JS) and batch (SQL) evaluators', async () => {
    await api().call('topics.set', { profileId: people.get('bo')!, topic: 'newsletter', status: 'unsubscribed' });
    // Ada refused the newsletter in the gateway test above; the others keep its subscribed default.
    const newsletter = [people.get('cy')!, people.get('dee')!, people.get('eve')!].sort();
    const product = [people.get('cy')!];

    const both = async (condition: object) =>
      t.srv.db.withWorkspace(ws, async (tx) => {
        const ctx = { tx, workspaceId: ws, events: t.srv.events };
        const js = [...(await evaluate(condition as never, ctx))];
        const m = await materialize(condition as never, ctx);
        const rows = await tx.execute<{ profile_id: string }>(sql.raw(`SELECT profile_id FROM ${m.table}`));
        return { js: js.sort(), batch: rows.rows.map((r) => r.profile_id).sort() };
      });

    expect(await both({ topic: 'newsletter' })).toEqual({ js: newsletter, batch: newsletter });
    expect(await both({ topic: 'product_news' })).toEqual({ js: product, batch: product });
    expect((await api().call('segments.preview', { condition: { topic: 'newsletter' } })).count).toBe(newsletter.length);
    const unknown = await rejects(api().call('segments.preview', { condition: { topic: 'nope' } }));
    expect(unknown.message).toContain('Unknown topic');
  });
});

describe('the hosted preference centre (#84)', () => {
  const tokenFor = (name: string) =>
    t.srv.email.links.sign({ w: ws, p: people.get(name)!, u: 'marketing_email', m: `msg-${name}-${Date.now()}` });
  const counts = (name: string) => {
    const id = people.get(name)!;
    return t.srv.db.withWorkspace(ws, async (tx) => {
      const prefs = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM topic_preferences WHERE workspace_id = ${ws} AND profile_id = ${id}`,
      );
      const history = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM topic_preference_history WHERE workspace_id = ${ws} AND profile_id = ${id}`,
      );
      return { prefs: prefs.rows[0].n, history: history.rows[0].n };
    });
  };

  it('never changes state on GET, and saves on POST with source preference_center', async () => {
    const token = tokenFor('dee');
    const before = await counts('dee');
    const page = await fetch(`${t.base}/u/p/${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Weekly newsletter');
    expect(html).toContain('Product news');
    expect(html).toMatch(/name="topic:newsletter" value="subscribed" checked/);
    expect(html).not.toMatch(/name="topic:product_news" value="subscribed" checked/);
    // The leave button names the purpose it withdraws, never "all marketing".
    expect(html).toMatch(/>Unsubscribe from [^<]+<\/button>/);
    expect(html).not.toContain('all marketing');
    expect(await counts('dee')).toEqual(before);

    // Uncheck newsletter (default subscribed) and check product news (default unsubscribed).
    const saved = await fetch(`${t.base}/u/p/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'topic:product_news': 'subscribed' }).toString(),
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('Your preferences are saved.');

    const rows = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ topic: string; status: string; source: string }>(
        sql`SELECT topic, status, source FROM topic_preferences WHERE workspace_id = ${ws} AND profile_id = ${people.get('dee')} ORDER BY topic`,
      ),
    );
    expect(rows.rows).toEqual([
      { topic: 'newsletter', status: 'unsubscribed', source: 'preference_center' },
      { topic: 'product_news', status: 'subscribed', source: 'preference_center' },
    ]);
    const history = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ topic: string; status: string; source: string }>(
        sql`SELECT topic, status, source FROM topic_preference_history WHERE workspace_id = ${ws} AND profile_id = ${people.get('dee')} ORDER BY id`,
      ),
    );
    expect(history.rows).toEqual([
      { topic: 'newsletter', status: 'unsubscribed', source: 'preference_center' },
      { topic: 'product_news', status: 'subscribed', source: 'preference_center' },
    ]);

    const prefs = await api().call('topics.preferences', { profileId: people.get('dee')! });
    expect(prefs.topics.find((x) => x.topic === 'newsletter')).toMatchObject({ status: 'unsubscribed', source: 'preference_center' });
    expect(prefs.topics.find((x) => x.topic === 'product_news')).toMatchObject({ status: 'subscribed', source: 'preference_center' });
  });

  it('"unsubscribe from <purpose>" does exactly what the unsubscribe link does', async () => {
    const token = tokenFor('eve');
    const res = await fetch(`${t.base}/u/p/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'unsubscribe_all' }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsubscribed');
    const history = await api().call('consent.history', { profileId: people.get('eve')! });
    expect(history.records.at(-1)).toMatchObject({
      purpose: 'marketing_email',
      channel: 'email',
      status: 'withdrawn',
      source: 'unsubscribe',
    });
  });

  it('the topic link unsubscribes only that topic, after a GET-safe confirm', async () => {
    const token = t.srv.email.links.sign({ w: ws, p: people.get('eve')!, u: 'marketing_email', topic: 'product_news', m: 'msg-topic-eve' });
    const confirm = await fetch(`${t.base}/u/t/${token}`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Unsubscribe from Product news');
    expect(
      (await api().call('topics.preferences', { profileId: people.get('eve')! })).topics.find((x) => x.topic === 'product_news')?.source,
    ).toBeNull();
    const done = await fetch(`${t.base}/u/t/${token}`, { method: 'POST' });
    expect(done.status).toBe(200);
    const prefs = await api().call('topics.preferences', { profileId: people.get('eve')! });
    expect(prefs.topics.find((x) => x.topic === 'product_news')).toMatchObject({ status: 'unsubscribed', source: 'unsubscribe_link' });
    // The purpose itself was not withdrawn by the topic link.
    const history = await api().call('consent.history', { profileId: people.get('eve')! });
    expect(history.records.at(-1)).toMatchObject({ status: 'withdrawn' });
  });
});

describe('agent rules and erasure (#84)', () => {
  it('lets an agent record an unsubscribe, never a subscribe', async () => {
    const token = await api().call('apiTokens.create', { name: 'Hermes', scopes: ['profiles:read', 'profiles:write'] });
    const agent = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
    const e = await rejects(agent.call('topics.set', { profileId: people.get('ada')!, topic: 'newsletter', status: 'subscribed' }));
    expect(e.status).toBe(403);
    expect(e.message).toContain('cannot subscribe');
    expect(await agent.call('topics.set', { profileId: people.get('ada')!, topic: 'newsletter', status: 'unsubscribed' })).toMatchObject({
      status: 'unsubscribed',
    });
  });

  it('erases topic choices and their history with the profile', async () => {
    const id = people.get('bo')!;
    await api().call('topics.set', { profileId: id, topic: 'newsletter', status: 'unsubscribed' });
    // An access request includes the choice and its history (#84).
    const exported = await api().call('profiles.export', { profileId: id, maxEvents: 0 });
    expect(exported.topicChoices).toEqual([expect.objectContaining({ topic: 'newsletter', status: 'unsubscribed' })]);
    expect(exported.topicHistory.at(-1)).toMatchObject({ topic: 'newsletter', status: 'unsubscribed' });
    await api().call('profiles.erase', { profileId: id, reason: 'test erasure' });
    const rows = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ prefs: number; history: number }>(
        sql`SELECT (SELECT count(*)::int FROM topic_preferences WHERE profile_id = ${id}) AS prefs,
          (SELECT count(*)::int FROM topic_preference_history WHERE profile_id = ${id}) AS history`,
      ),
    );
    expect(rows.rows[0]).toEqual({ prefs: 0, history: 0 });
  });
});
