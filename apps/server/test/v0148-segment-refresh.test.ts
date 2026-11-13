import type { EventBus } from '@agentic-marketing/events';
import { publishedSegments, publishInSlices, refreshPeople, refreshSegment } from '@agentic-marketing/segments';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const refreshIds = (artifactId: string) =>
  t.srv.db.withWorkspace(ws, async (tx) => {
    const all = await publishedSegments(tx);
    const seg = all.find((s) => s.id === artifactId);
    if (!seg) throw new Error('segment not found');
    const run = await refreshSegment(tx, ws, seg, t.srv.events, all);
    return run.changes.map((e) => e.messageId);
  });

const removeMembership = (artifactId: string) =>
  t.srv.db.admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2', [ws, artifactId]);

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

describe('republishing the same commit’s events', () => {
  it('keeps their messageIds when the change set is published again (#628)', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'People in Tromsø',
      content: { condition: { trait: 'city', op: 'eq', value: 'Tromso' } },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => r.total === 0 && r.members.length === 0,
    );
    await setCity(adaId, 'Tromso');

    const published: string[][] = [];
    const bus = {
      publish: async (events: { messageId: string }[]) => {
        published.push(events.map((e) => e.messageId));
        return { accepted: events.length, duplicates: 0 };
      },
    } as unknown as EventBus;

    const ids = await t.srv.db.withWorkspace(ws, async (tx) => {
      const all = await publishedSegments(tx);
      const seg = all.find((s) => s.id === artifactId);
      if (!seg) throw new Error('segment not found');
      const run = await refreshSegment(tx, ws, seg, t.srv.events, all);
      // A bus retry republishes the same committed change set; the ids are part of the events and
      // must not be regenerated per publish.
      await publishInSlices(bus, run.changes);
      await publishInSlices(bus, run.changes);
      return run.changes.map((e) => e.messageId);
    });

    expect(ids).toHaveLength(1);
    expect(published).toEqual([ids, ids]);
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
    const retryIds = await refreshIds(artifactId);
    expect(retryIds).toEqual(firstIds);
  }, 60_000);
});

describe('a reusable preference link (#781)', () => {
  it('gives a segment re-entry a new messageId even with the same caller cause', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'People in Fredrikstad',
      content: { condition: { trait: 'city', op: 'eq', value: 'Fredrikstad' } },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => r.total === 0 && r.members.length === 0,
    );

    // A preference-centre token is reusable, so every topic-changing submission passes the same
    // cause. JetStream drops a duplicate msgID for two minutes, so a re-entry used to be lost.
    const cause = `preferences:${adaId}`;
    // The round also re-evaluates the other segments this file published, so keep only ours.
    const refresh = async () => {
      const changes = await t.srv.db.withWorkspace(ws, (tx) => refreshPeople(tx, ws, [adaId], t.srv.events, cause));
      return changes.filter((e) => e.properties.segment_id === artifactId).map((e) => e.messageId);
    };

    await setCity(adaId, 'Fredrikstad');
    const first = await refresh();
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(':in:');

    // The person leaves and re-enters the topic segment before the duplicate window closes.
    await removeMembership(artifactId);
    const second = await refresh();
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
  }, 60_000);
});

describe('a refresh token that would repeat its predecessor', () => {
  it('still gives the next changes new messageIds after a streaming reversal', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'People in Stavanger',
      content: { condition: { trait: 'city', op: 'eq', value: 'Stavanger' } },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => r.total === 0 && r.members.length === 0,
    );
    await setCity(adaId, 'Stavanger');

    // Freeze the wall clock: `new Date()` returns the same millisecond for every run. A streaming
    // update reverses the membership between runs, so the unchanged `in` change repeats. The token
    // written by each refresh must still advance (GREATEST(clock_timestamp(), previous + 1µs)).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    let runs: string[][] = [];
    try {
      const first = await refreshIds(artifactId);
      await removeMembership(artifactId);
      const second = await refreshIds(artifactId);
      await removeMembership(artifactId);
      const third = await refreshIds(artifactId);
      runs = [first, second, third];
    } finally {
      vi.useRealTimers();
    }

    expect(runs[0]).toHaveLength(1);
    expect(runs[1]).toHaveLength(1);
    expect(runs[2]).toHaveLength(1);
    // The second and third runs share the same change set; only an advancing token separates them.
    expect(runs[1]).not.toEqual(runs[2]);
  }, 60_000);
});
