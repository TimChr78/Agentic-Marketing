import type { EventBus } from '@agentic-marketing/events';
import { publishedSegments, publishInSlices, refreshSegment } from '@agentic-marketing/segments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #628: a segment refresh's change-event cause is derived from the state the transaction commits,
// so two refreshes in the same minute both deliver, while a retry of one rolled-back run reuses the
// same messageIds and deduplicates in JetStream.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let adaId = '';
let boId = '';

beforeAll(async () => {
  t = await startTestServer('test_v0148_segments', testPort(3498));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  const key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({
      batch: [
        { type: 'identify', userId: 'ada', traits: { city: 'Odense', email: 'ada@example.com' } },
        { type: 'identify', userId: 'bo', traits: { city: 'Trondheim', email: 'bo@example.com' } },
      ],
    }),
  });
  const api = t.api(owner);
  adaId = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'ada' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  boId = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'bo' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
}, 60_000);

afterAll(() => t?.close());

const setCity = (profileId: string, city: string) =>
  t.srv.db.admin.query(`UPDATE profiles SET traits = jsonb_build_object('city', $3::text) WHERE workspace_id = $1 AND id = $2`, [
    ws,
    profileId,
    city,
  ]);

const waitForRoomInTheMinute = async () => {
  // The sequence below is short, but leave most of a minute so a slow runner cannot cross the
  // boundary between the three refreshes; that is the condition that reproduced the defect.
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 20_000) await new Promise((r) => setTimeout(r, left + 100));
};

describe('two committed refreshes in the same minute (#628)', () => {
  it('publishes both runs with distinct messageIds', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'People in Aarhus',
      content: { condition: { trait: 'city', op: 'eq', value: 'Aarhus' } },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => r.total === 0 && r.members.length === 0,
    );

    await waitForRoomInTheMinute();

    // The same person enters, leaves and enters again, each through its own committed refresh. The
    // first and third runs emit the same segment/profile/direction; only the committed state token
    // distinguishes them.
    await setCity(adaId, 'Aarhus');
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ entered: 1, exited: 0 });
    await setCity(adaId, 'Odense');
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ entered: 0, exited: 1 });
    await setCity(adaId, 'Aarhus');
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ entered: 1, exited: 0 });

    // Both "Segment Entered" events reach the event store. Before #628 the third run's event had
    // the first run's messageId and JetStream silently dropped it.
    const page = await eventually(
      () => api.call('profiles.events', { profileId: adaId, limit: 100 }),
      (r) =>
        r.events.filter((e) => e.name === 'Segment Entered' && e.properties.segment_id === artifactId).length >= 2 &&
        r.events.some((e) => e.name === 'Segment Exited' && e.properties.segment_id === artifactId),
    );
    const entered = page.events.filter((e) => e.name === 'Segment Entered' && e.properties.segment_id === artifactId);
    expect(entered).toHaveLength(2);
    expect(new Set(entered.map((e) => e.eventId)).size).toBe(2);
  }, 60_000);
});

describe('a refresh whose publish fails partway', () => {
  it('reuses the same messageIds when the rolled-back run is retried', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'People in Bergen',
      content: { condition: { trait: 'city', op: 'eq', value: 'Bergen' } },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => r.total === 0 && r.members.length === 0,
    );
    await setCity(adaId, 'Bergen');
    await setCity(boId, 'Bergen');

    // The run commits nothing: its first published slice is accepted, then the next publish fails
    // and the workspace transaction rolls back, exactly as a JetStream outage would.
    let firstIds: string[] = [];
    let publishes = 0;
    const flakyBus = {
      publish: async (events: unknown[]) => {
        publishes++;
        if (publishes > 1) throw new Error('injected publish failure');
        return { accepted: events.length, duplicates: 0 };
      },
    } as unknown as EventBus;
    await expect(
      t.srv.db.withWorkspace(ws, async (tx) => {
        const all = await publishedSegments(tx);
        const seg = all.find((s) => s.id === artifactId);
        if (!seg) throw new Error('segment not found');
        const run = await refreshSegment(tx, ws, seg, t.srv.events, all);
        firstIds = run.changes.map((e) => e.messageId);
        await publishInSlices(flakyBus, run.changes, 1);
      }),
    ).rejects.toThrow('injected publish failure');
    expect(publishes).toBe(2);
    expect(firstIds).toHaveLength(2);

    // The retry sees the same committed token and the same change set, so its ids match.
    const retryIds = await t.srv.db.withWorkspace(ws, async (tx) => {
      const all = await publishedSegments(tx);
      const seg = all.find((s) => s.id === artifactId);
      if (!seg) throw new Error('segment not found');
      const run = await refreshSegment(tx, ws, seg, t.srv.events, all);
      return run.changes.map((e) => e.messageId);
    });
    expect(retryIds).toEqual(firstIds);
  }, 60_000);
});
