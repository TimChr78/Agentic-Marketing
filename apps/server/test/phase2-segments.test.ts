import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Phase 2, segments: the DSL evaluated in batch (preview, scheduled refresh) and streaming (an
// event that makes someone match puts them in the segment within seconds, with an event).

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let key: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestServer('test_p2s', 3295);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 60_000);
afterAll(() => t?.close());

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });
const views = (userId: string, n: number, category = 'tents') =>
  Array.from({ length: n }, () => ({ type: 'track', event: 'Product Viewed', userId, properties: { category } }));

const tentLovers = {
  all: [
    { trait: 'city', op: 'eq', value: 'Aarhus' },
    { event: 'Product Viewed', where: { category: 'tents' }, count: { gte: 2 }, within: 'P7D' },
  ],
};

describe('segments', () => {
  it('previews a definition over traits and events', async () => {
    await send([
      { type: 'identify', userId: 'ada', traits: { city: 'Aarhus', email: 'ada@example.com' } },
      ...views('ada', 3),
      { type: 'identify', userId: 'bo', traits: { city: 'Odense' } },
      ...views('bo', 1),
      { type: 'identify', userId: 'cy', traits: { city: 'Aarhus' } },
      ...views('cy', 2, 'jackets'),
    ]);
    const api = t.api(owner);
    for (const u of ['ada', 'bo', 'cy'])
      ids[u] = (
        await eventually(
          () => api.call('profiles.find', { type: 'user_id', value: u }),
          (r) => !!r.profileId,
        )
      ).profileId!;
    // Wait until ClickHouse has the views.
    await eventually(
      () => api.call('profiles.events', { profileId: ids.cy }),
      (r) => r.events.length === 3,
    );

    expect(await api.call('segments.preview', { condition: tentLovers })).toMatchObject({ count: 1, sample: [ids.ada] });
    expect(
      (
        await api.call('segments.preview', { condition: { event: 'Product Viewed', where: { category: 'tents' }, count: { lte: 0 } } })
      ).sample.sort(),
    ).toEqual([ids.cy]);
    expect(
      (
        await api.call('segments.preview', {
          condition: { any: [{ trait: 'city', op: 'in', value: ['Odense', 'Vejle'] }, { not: { trait: 'city', op: 'exists' } }] },
        })
      ).sample,
    ).toEqual([ids.bo]);
    expect((await api.call('segments.preview', { condition: { consent: 'marketing_email' } })).count).toBe(0);
    const pii = await rejects(api.call('segments.preview', { condition: { trait: 'email', op: 'contains', value: '@example.com' } }));
    expect(pii.status).toBe(400);
    expect(pii.message).toContain('personal data');
  });

  it('keeps a published segment current: scheduled refresh, then streaming, with change events', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Tent lovers in Aarhus',
      content: { condition: tentLovers },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    const first = await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => r.members.length === 1,
    );
    expect(first.members.map((m) => m.profileId)).toEqual([ids.ada]);
    await eventually(
      () => api.call('profiles.events', { profileId: ids.ada }),
      (r) => r.events.some((e) => e.name === 'Segment Entered' && e.properties.segment_id === artifactId),
    );

    // Bo moves to Aarhus and looks at tents again: streaming puts him in right away.
    const started = Date.now();
    await send([{ type: 'identify', userId: 'bo', traits: { city: 'Aarhus' } }, ...views('bo', 1)]);
    await eventually(
      () => api.call('segments.ofProfile', { profileId: ids.bo }),
      (r) => r.segments.some((s) => s.id === artifactId),
    );
    expect(Date.now() - started).toBeLessThan(5_000);

    // Ada moves away: she leaves, and the exit is an event too.
    await send([{ type: 'identify', userId: 'ada', traits: { city: 'Copenhagen' } }]);
    await eventually(
      () => api.call('profiles.events', { profileId: ids.ada }),
      (r) => r.events.some((e) => e.name === 'Segment Exited'),
    );
    expect((await api.call('segments.members', { artifactId })).members.map((m) => m.profileId)).toEqual([ids.bo]);

    // Segments can build on each other; loops are refused.
    expect(
      await api.call('segments.preview', { condition: { all: [{ segment: artifactId }, { trait: 'city', op: 'eq', value: 'Aarhus' }] } }),
    ).toMatchObject({ count: 1 });
    const loop = await api.call('artifacts.updateDraft', { artifactId, content: { condition: { segment: artifactId } } });
    expect((await rejects(api.call('segments.preview', { artifactId, version: loop.version }))).message).toContain('loop');
  });
});
