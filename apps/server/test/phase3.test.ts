import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, type User } from './harness';

// Phase 3 acceptance: "next-page-view and same-page personalization with measured p95 < 50 ms
// server time". A visitor's behaviour reaches the decision API through ingest (session state)
// and the profile workers (profile snapshot with segments).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let key: string;
const ids = { hero: '', banner: '', overlay: '' };
const yes = { consent: { categoryPreferences: { analytics: true, web_personalization: true } } };
const contextualOnly = { consent: { categoryPreferences: { analytics: true, web_personalization: false } } };

beforeAll(async () => {
  t = await startTestServer('test_p3', 3293);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  key = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: ['*'] })).key;

  const seg = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Tent shoppers',
    content: { condition: { event: 'Product Viewed', where: { category: 'tents' }, count: { gte: 2 }, within: 'P7D' } },
  });
  await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'x' });
  const create = async (name: string, content: unknown) => {
    const a = await api.call('artifacts.create', { type: 'experience', name, content });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
    return a.artifactId;
  };
  ids.hero = await create('Tent hero', {
    placement: 'home_hero',
    targeting: { segment: seg.artifactId },
    variants: [
      { id: 'a', name: 'Lifestyle', weight: 50, content: { html: '<h1>Your next camp</h1>' } },
      { id: 'b', name: 'Discount', weight: 50, content: { html: '<h1>10% off tents</h1>' } },
    ],
    holdoutPercent: 0,
    goal: { event: 'Order Completed' },
  });
  ids.banner = await create('Newsletter banner', {
    placement: 'top_banner',
    targeting: { utmSource: 'newsletter' },
    variants: [{ id: 'a', name: 'Welcome back', weight: 100, content: { html: '<p>Welcome back, reader!</p>' } }],
  });
  ids.overlay = await create('Exit offer', {
    placement: 'overlay',
    targeting: { session: 'Product Viewed', count: { gte: 2 } },
    trigger: { type: 'exit_intent' },
    variants: [{ id: 'a', name: 'Offer', weight: 100, content: { json: { code: 'STAY10' } } }],
  });
}, 60_000);
afterAll(() => t?.close());

const post = (path: string, body: unknown) =>
  fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify(body),
  });
const decide = async (anonymousId: string, context: unknown, url = 'https://shop.example.com/') => {
  const res = await post('/v1/decide', {
    anonymousId,
    placements: ['home_hero', 'top_banner', 'overlay'],
    page: { url, path: new URL(url).pathname },
    context,
  });
  expect(res.status).toBe(200);
  return { ...(await res.json()), serverMs: Number(res.headers.get('server-timing')?.match(/dur=([\d.]+)/)?.[1]) };
};
const view = (anonymousId: string, n: number, context: unknown = yes) =>
  post('/v1/batch', {
    batch: Array.from({ length: n }, () => ({
      type: 'track',
      event: 'Product Viewed',
      anonymousId,
      properties: { category: 'tents' },
      context,
    })),
  });

describe('decision API', () => {
  it('personalizes the next page view from this session’s behaviour and the visitor’s segments', async () => {
    expect((await decide('v1', yes)).decisions).toEqual([]);

    await view('v1', 2);
    // Session state is written before ingest answers: the very next decide sees it.
    const next = await decide('v1', yes);
    expect(next.decisions.map((d: { placement: string }) => d.placement)).toEqual(['overlay']);
    expect(next.decisions[0]).toMatchObject({
      experienceId: ids.overlay,
      trigger: { type: 'exit_intent' },
      content: { json: { code: 'STAY10' } },
    });

    // The profile worker and segments put v1 in "Tent shoppers"; the snapshot reaches Valkey.
    const later = await eventually(
      () => decide('v1', yes),
      (r) => r.decisions.some((d: { placement: string }) => d.placement === 'home_hero'),
    );
    const hero = later.decisions.find((d: { placement: string }) => d.placement === 'home_hero');
    expect(['a', 'b']).toContain(hero.variantId);
    // Sticky: the same person keeps the same variant.
    for (let i = 0; i < 5; i++)
      expect((await decide('v1', yes)).decisions.find((d: { placement: string }) => d.placement === 'home_hero').variantId).toBe(
        hero.variantId,
      );
  });

  it('uses only the page without personalization consent', async () => {
    await view('v2', 3, contextualOnly);
    await new Promise((r) => setTimeout(r, 2000));
    const r = await decide('v2', contextualOnly, 'https://shop.example.com/?utm_source=newsletter');
    expect(r.personalized).toBe(false);
    expect(r.decisions.map((d: { placement: string }) => d.placement)).toEqual(['top_banner']);
  });

  it('answers within 50 ms at p95 (server time)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 200; i++) times.push((await decide(i % 2 ? 'v1' : `anon-${i}`, yes)).serverMs);
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(p95).toBeLessThan(50);
  });

  it('rejects bad keys and answers preflights', async () => {
    const bad = await fetch(`${t.base}/v1/decide`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from('pk_nope:').toString('base64')}` },
      body: '{"placements":["x"]}',
    });
    expect(bad.status).toBe(401);
    expect((await fetch(`${t.base}/v1/decide`, { method: 'OPTIONS', headers: { origin: 'https://shop.example.com' } })).status).toBe(204);
  });
});
