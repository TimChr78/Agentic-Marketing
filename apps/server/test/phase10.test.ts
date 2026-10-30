import { releaseTokens, reserveTokens } from '@agentic-marketing/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 10 (wave 2), part a: correctness under concurrency and change. AI budgets hold with
// parallel calls, e-mail adapters go through the egress guard, a merge wakes waiting journey
// participants, published experiences show at once, and journeys move people between versions.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });
async function publish(type: string, name: string, content: unknown) {
  const api = t.api(owner);
  const a = await api.call('artifacts.create', { type: type as 'note', name, content: content as Record<string, unknown> });
  await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
  return a.artifactId;
}

beforeAll(async () => {
  t = await startTestServer('test_p10', testPort(3287));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 60_000);
afterAll(() => t?.close());

describe('AI budgets under concurrency', () => {
  it('lets only as many parallel reservations through as the budget holds', async () => {
    const api = t.api(owner);
    const p = await api.call('aiProviders.create', {
      name: 'Budgeted',
      kind: 'openai-compatible',
      baseUrl: 'https://llm.example.com/v1',
      models: { default: 'm' },
      apiKey: 'sk-test-0123456789',
      useFor: ['journeys'],
      monthlyTokenBudget: 1000,
    });
    const results = await Promise.allSettled([reserveTokens(t.srv.db, ws, p.id, 600), reserveTokens(t.srv.db, ws, p.id, 600)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('budget');
    expect((await api.call('aiProviders.list', {})).providers[0].usedThisMonth).toBe(600);
    await releaseTokens(t.srv.db, ws, (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value);
    expect((await api.call('aiProviders.list', {})).providers[0].usedThisMonth).toBe(0);
  });
});

describe('e-mail adapters behind the egress guard', () => {
  it('refuses a provider endpoint on a private address', async () => {
    const api = t.api(owner);
    await api.call('emailProviders.create', {
      name: 'Rogue',
      adapter: 'cloudflare',
      config: { accountId: 'a'.repeat(32), apiBase: 'http://169.254.169.254/latest' },
      secrets: { apiToken: 'cf-token-0123456789abcdef' },
      fromEmail: 'news@example.com',
      useFor: ['transactional', 'marketing'],
    });
    await send([
      { type: 'identify', userId: 'u-egress', traits: { email: 'egress@example.com' } },
      {
        type: 'track',
        event: 'Segment Consent Preference Updated',
        userId: 'u-egress',
        context: { consent: { categoryPreferences: { marketing_email: true } } },
      },
    ]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'u-egress' }),
      (r) => !!r.profileId,
    );
    const tpl = await publish('email_template', 'Hi', {
      purpose: 'onboarding',
      subject: 'Hi',
      mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
    });
    await api.call('messages.sendEmail', { profileId: profileId!, templateId: tpl });
    const { messages } = await eventually(
      () => api.call('messages.list', { profileId: profileId! }),
      (r) => !!r.messages[0]?.reason?.startsWith('provider_error'),
    );
    expect(messages[0].reason).toContain('private address');
  });
});

describe('journeys', () => {
  it('wakes a waiting participant when its profile is merged into another', async () => {
    const api = t.api(owner);
    const journey = await publish('journey', 'Signup follow-up', {
      purpose: 'onboarding',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' } },
        {
          id: 'wait',
          kind: 'waitEvent',
          label: 'Ordered?',
          config: { event: 'Order Completed', timeout: 'P7D' },
          next: [{ to: 'mark' }, { to: 'done' }],
        },
        { id: 'mark', kind: 'updateProfile', label: 'Buyer', config: { trait: 'stage', value: 'buyer' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    // The older profile (logged-in customer) and a newer anonymous visitor who signs up.
    await send([{ type: 'identify', userId: 'u-merge', anonymousId: 'anon-old', traits: { plan: 'pro' } }]);
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'u-merge' }),
      (r) => !!r.profileId,
    );
    await send([{ type: 'track', event: 'Signed Up', anonymousId: 'anon-new' }]);
    await eventually(
      () => api.call('journeys.stats', { artifactId: journey }),
      (s) => s.waitingAt.wait === 1,
    );
    // Logging in links the new visitor to the customer: the newer profile merges into the older one.
    await send([{ type: 'identify', userId: 'u-merge', anonymousId: 'anon-new' }]);
    const customer = (await api.call('profiles.find', { type: 'user_id', value: 'u-merge' })).profileId!;
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'anonymous_id', value: 'anon-new' }),
      (r) => r.profileId === customer,
    );
    await new Promise((r) => setTimeout(r, 500));
    // The order comes from the customer's other device.
    await send([{ type: 'track', event: 'Order Completed', anonymousId: 'anon-old', userId: 'u-merge' }]);
    const p = await eventually(
      () => api.call('profiles.get', { profileId: profileId! }),
      (x) => x.traits.stage === 'buyer',
      15_000,
    );
    expect(p.traits.stage).toBe('buyer');
  });

  it('moves participants to a new version, keeping their waits', async () => {
    const api = t.api(owner);
    const def = (label: string) => ({
      purpose: 'onboarding',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Entered', config: { event: 'Trial Started' } },
        { id: 'pause', kind: 'wait', label, config: { duration: 'P3D' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    const journey = await publish('journey', 'Trial', def('Wait 3 days'));
    await send([{ type: 'track', event: 'Trial Started', userId: 'u-trial' }]);
    await eventually(
      () => api.call('journeys.stats', { artifactId: journey }),
      (s) => s.waitingAt.pause === 1,
    );
    await api.call('artifacts.updateDraft', { artifactId: journey, content: def('Wait 3 days (v2)') });
    await api.call('artifacts.requestPublish', { artifactId: journey, note: 'v2' });
    expect(
      (await rejects(api.call('journeys.migrate', { artifactId: journey, mapping: { pause: 'nowhere' }, dryRun: true }))).message,
    ).toContain('no node "nowhere"');
    const dry = await api.call('journeys.migrate', { artifactId: journey, dryRun: true });
    expect(dry).toMatchObject({ toVersion: 2, moved: 1, restarted: 0, byNode: [{ fromVersion: 1, from: 'pause', to: 'pause', count: 1 }] });
    expect(await api.call('journeys.migrate', { artifactId: journey, dryRun: false })).toMatchObject({ moved: 1 });
    expect(await api.call('journeys.migrate', { artifactId: journey, dryRun: true })).toMatchObject({ moved: 0, stayed: 0 });
    expect((await api.call('journeys.stats', { artifactId: journey })).waitingAt.pause).toBe(1);
  });
});

describe('experiences', () => {
  it('serves a newly published version within seconds, not after the 30 s cache', async () => {
    const api = t.api(owner);
    const browser = (await api.call('sources.create', { name: 'Site', kind: 'browser', allowedOrigins: ['*'] })).key;
    const content = (html: string) => ({ placement: 'home_hero', variants: [{ id: 'a', name: 'A', weight: 100, content: { html } }] });
    const exp = await publish('experience', 'Hero', content('<h1>Old</h1>'));
    const decide = async () =>
      (
        await (
          await fetch(`${t.base}/v1/decide`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${browser}:`).toString('base64')}` },
            body: JSON.stringify({ anonymousId: 'anon-exp', placements: ['home_hero'], page: { url: 'https://x.example/', path: '/' } }),
          })
        ).json()
      ).decisions[0]?.content?.html;
    expect(await decide()).toBe('<h1>Old</h1>');
    await api.call('artifacts.updateDraft', { artifactId: exp, content: content('<h1>New</h1>') });
    await api.call('artifacts.requestPublish', { artifactId: exp, note: 'v2' });
    const started = Date.now();
    await eventually(decide, (html) => html === '<h1>New</h1>', 5000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
