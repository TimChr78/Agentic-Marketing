import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #628: a scheduled segment refresh used a minute-truncated timestamp as its change-event cause.
// Two refreshes in the same minute therefore produced identical messageIds, and JetStream's
// two-minute dedupe dropped the second run's events. The cause is now unique per refresh run, while
// retrying a publish keeps the ids of the events it already built.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let profileId = '';

beforeAll(async () => {
  t = await startTestServer('test_v0148_segments', testPort(3498));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  const key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({
      batch: [{ type: 'identify', userId: 'ada', traits: { city: 'Odense', email: 'ada@example.com' } }],
    }),
  });
  const api = t.api(owner);
  profileId = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'ada' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
}, 60_000);

afterAll(() => t?.close());

const setCity = (city: string) =>
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

describe('two segment refreshes in the same minute (#628)', () => {
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

    // The same person enters, leaves and enters again, each through its own refresh. The first and
    // third runs emit the same segment/profile/direction; only the run's cause distinguishes them.
    await setCity('Aarhus');
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ entered: 1, exited: 0 });
    await setCity('Odense');
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ entered: 0, exited: 1 });
    await setCity('Aarhus');
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ entered: 1, exited: 0 });

    // Both "Segment Entered" events reach the event store. Before the fix the third run's event had
    // the first run's messageId and JetStream silently dropped it.
    const page = await eventually(
      () => api.call('profiles.events', { profileId, limit: 100 }),
      (r) =>
        r.events.filter((e) => e.name === 'Segment Entered' && e.properties.segment_id === artifactId).length >= 2 &&
        r.events.some((e) => e.name === 'Segment Exited' && e.properties.segment_id === artifactId),
    );
    const entered = page.events.filter((e) => e.name === 'Segment Entered' && e.properties.segment_id === artifactId);
    expect(entered).toHaveLength(2);
    expect(new Set(entered.map((e) => e.eventId)).size).toBe(2);
    // The cause is a per-run id, not a minute-truncated timestamp.
    for (const event of entered) expect(event.eventId).toMatch(/:run:run_[0-9a-f]{32}$/);
  }, 60_000);
});
