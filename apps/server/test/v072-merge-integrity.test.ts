import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.7.2 (#395, #396): an identity merge carries the person's topic choices and static/snapshot
// list memberships to the survivor. Topic choices: newest wins, an opt-out wins an exact tie.
// List membership: source list and materialized copy move and deduplicate, while dynamic
// memberships stay derived from the rule and are recomputed by the next refresh.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let newsletterTemplate = '';

const api = () => t.api(owner, ws);
const publish = (artifactId: string) => api().call('artifacts.requestPublish', { artifactId, note: 'test' });

const mjml = `<mjml><mj-body><mj-section><mj-column>
  <mj-text>Hello {{ profile.firstName | default: 'there' }}</mj-text>
  <mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>
</mj-column></mj-section></mj-body></mjml>`;

const purposesContent = {
  purposes: DEFAULT_PURPOSES.map((p) =>
    p.key === 'marketing_email'
      ? {
          ...p,
          topics: [{ key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' as const }],
        }
      : p,
  ),
};

beforeAll(async () => {
  t = await startTestServer('test_v072_merge_integrity', testPort(3494));
  owner = await t.signUp(`merge-${Date.now()}@example.com`);
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
  const template = await a.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly newsletter',
    content: { purpose: 'marketing_email', topic: 'newsletter', subject: 'The Friday issue', mjml },
  });
  await publish(template.artifactId);
  newsletterTemplate = template.artifactId;
  key = (await a.call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 90_000);

afterAll(() => t?.close());

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch }),
  });

async function person(ids: { userId?: string; anonymousId?: string }, traits: Record<string, unknown> = {}) {
  await send([{ type: 'identify', ...ids, traits }]);
  const lookup = ids.userId
    ? ({ type: 'user_id', value: ids.userId } as const)
    : ({ type: 'anonymous_id', value: ids.anonymousId! } as const);
  return (
    await eventually(
      () => api().call('profiles.find', lookup),
      (r) => !!r.profileId,
    )
  ).profileId!;
}

async function merge(ids: { userId?: string; anonymousId?: string }) {
  await send([{ type: 'identify', ...ids }]);
}

async function mergedInto(loser: string, survivor: string) {
  await eventually(
    async () =>
      t.srv.db.withWorkspace(ws, async (tx) => {
        const { rows } = await tx.execute<{ merged_into: string | null }>(
          sql`SELECT merged_into FROM profiles WHERE workspace_id = ${ws} AND id = ${loser}`,
        );
        return rows[0]?.merged_into ?? null;
      }),
    (id) => id === survivor,
  );
}

const topicStatus = async (profileId: string, topic = 'newsletter') =>
  (await api().call('topics.preferences', { profileId })).topics.find((x) => x.topic === topic)!;

describe('topic choices survive a merge (#395)', () => {
  it('moves a loser-only opt-out to the survivor, keeps its history reachable and gates the send', async () => {
    const survivor = await person({ userId: 'u-topic-a' }, { email: 'topic-a@example.com' });
    const loser = await person({ anonymousId: 'anon-topic-b' }, { plan: 'pro' });
    await api().call('topics.set', { profileId: loser, topic: 'newsletter', status: 'unsubscribed', note: 'asked by e-mail' });
    expect(await topicStatus(survivor)).toMatchObject({ status: 'subscribed', source: null });

    await merge({ userId: 'u-topic-a', anonymousId: 'anon-topic-b' });
    await mergedInto(loser, survivor);

    const moved = await eventually(
      () => api().call('topics.preferences', { profileId: survivor }),
      (r) => r.topics.find((x) => x.topic === 'newsletter')?.status === 'unsubscribed',
    );
    expect(moved.topics.find((x) => x.topic === 'newsletter')).toMatchObject({ status: 'unsubscribed', source: 'api' });
    expect((await api().call('profiles.get', { profileId: survivor })).mergedFrom).toContain(loser);

    // The append-only evidence stays on the merged-away id and the export reads the whole family.
    const history = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ profile_id: string; status: string; source: string; note: string | null }>(
        sql`SELECT profile_id, status, source, note FROM topic_preference_history
            WHERE workspace_id = ${ws} AND topic = 'newsletter' AND profile_id IN (${survivor}, ${loser}) ORDER BY id`,
      ),
    );
    expect(history.rows).toEqual([{ profile_id: loser, status: 'unsubscribed', source: 'api', note: 'asked by e-mail' }]);
    const exported = await api().call('profiles.export', { profileId: survivor, maxEvents: 0 });
    expect(exported.topicHistory).toEqual([
      expect.objectContaining({ topic: 'newsletter', status: 'unsubscribed', source: 'api', note: 'asked by e-mail' }),
    ]);

    // The send path reads the survivor's reconciled choice.
    await api().call('consent.record', {
      profileId: survivor,
      purpose: 'marketing_email',
      channel: 'email',
      status: 'granted',
      source: 'api',
      proof: { test: true },
    });
    expect(await api().call('messages.sendEmail', { profileId: survivor, templateId: newsletterTemplate })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('topic_unsubscribed'),
    });
  });

  it('keeps the newest choice when both profiles have one', async () => {
    const survivor = await person({ userId: 'u-topic-newer' });
    const loser = await person({ anonymousId: 'anon-topic-newer' });
    await api().call('topics.set', { profileId: survivor, topic: 'newsletter', status: 'subscribed', note: 'older' });
    await api().call('topics.set', { profileId: loser, topic: 'newsletter', status: 'unsubscribed', note: 'newer' });

    await merge({ userId: 'u-topic-newer', anonymousId: 'anon-topic-newer' });
    await mergedInto(loser, survivor);
    expect(await topicStatus(survivor)).toMatchObject({ status: 'unsubscribed', source: 'api' });

    // A repeated merge still follows the same rule: a later choice can subscribe again.
    const third = await person({ anonymousId: 'anon-topic-newer-2' });
    await api().call('topics.set', { profileId: third, topic: 'newsletter', status: 'subscribed', note: 'newest' });
    // Pin the order so the test does not depend on two commands landing in different milliseconds.
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`
        UPDATE topic_preferences SET updated_at = CASE profile_id
          WHEN ${survivor} THEN '2026-01-15T00:00:00Z'::timestamptz
          ELSE '2026-02-01T00:00:00Z'::timestamptz END
        WHERE workspace_id = ${ws} AND topic = 'newsletter' AND profile_id IN (${survivor}, ${third})`),
    );
    await merge({ userId: 'u-topic-newer', anonymousId: 'anon-topic-newer-2' });
    await mergedInto(third, survivor);
    expect(await topicStatus(survivor)).toMatchObject({ status: 'subscribed', source: 'api' });
    expect(
      await t.srv.db.withWorkspace(ws, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM topic_preferences WHERE workspace_id = ${ws} AND profile_id = ${third}`,
        ),
      ),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });

  it('lets an opt-out win an exact timestamp tie', async () => {
    const survivor = await person({ userId: 'u-topic-tie' });
    const loser = await person({ anonymousId: 'anon-topic-tie' });
    await api().call('topics.set', { profileId: survivor, topic: 'newsletter', status: 'subscribed' });
    await api().call('topics.set', { profileId: loser, topic: 'newsletter', status: 'unsubscribed' });
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`
        UPDATE topic_preferences SET updated_at = '2026-01-01T00:00:00Z'
        WHERE workspace_id = ${ws} AND topic = 'newsletter' AND profile_id IN (${survivor}, ${loser})`),
    );

    await merge({ userId: 'u-topic-tie', anonymousId: 'anon-topic-tie' });
    await mergedInto(loser, survivor);
    expect(await topicStatus(survivor)).toMatchObject({ status: 'unsubscribed' });
  });
  it('applies old signed topic and preference links to the surviving profile', async () => {
    const survivor = await person({ userId: 'u-old-topic-link' }, { email: 'old-topic-link@example.com' });
    const loser = await person({ anonymousId: 'anon-old-topic-link' }, { plan: 'link-fixture' });
    const token = t.srv.email.links.sign({ w: ws, p: loser, u: 'marketing_email', topic: 'newsletter', m: 'msg-old-topic-link' });
    const preferences = t.srv.email.links.sign({ w: ws, p: loser, u: 'marketing_email', m: 'msg-old-preferences-link' });
    await merge({ userId: 'u-old-topic-link', anonymousId: 'anon-old-topic-link' });
    await mergedInto(loser, survivor);
    expect((await fetch(`${t.base}/u/t/${token}`, { method: 'POST' })).status).toBe(200);
    expect(await topicStatus(survivor)).toMatchObject({ status: 'unsubscribed', source: 'unsubscribe_link' });
    expect((await fetch(`${t.base}/u/p/${preferences}`)).status).toBe(200);
    expect(
      (
        await fetch(`${t.base}/u/p/${preferences}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ 'topic:newsletter': 'subscribed' }),
        })
      ).status,
    ).toBe(200);
    expect(await topicStatus(survivor)).toMatchObject({ status: 'subscribed', source: 'preference_center' });
    const rows = await t.srv.db.admin.query('SELECT topic FROM topic_preferences WHERE workspace_id = $1 AND profile_id = $2', [ws, loser]);
    expect(rows.rows).toEqual([]);
  });
});

describe('static and snapshot memberships follow a merge (#396)', () => {
  async function createList(name: string) {
    const a = await api().call('artifacts.create', { type: 'segment', name, content: { mode: 'static' } });
    return a.artifactId;
  }

  it('moves a static list membership to the survivor, deduplicates and keeps counts canonical', async () => {
    const survivor = await person({ userId: 'u-list-a' }, { email: 'list-a@example.com' });
    const loser = await person({ anonymousId: 'anon-list-b' });
    const list = await createList('Partner list');
    await api().call('audiences.add', { segmentId: list, profileIds: [loser] });

    const before = await api().call('segments.members', { artifactId: list });
    expect(before).toMatchObject({ total: 1 });
    expect(before.members.map((m) => m.profileId)).toEqual([loser]);

    await merge({ userId: 'u-list-a', anonymousId: 'anon-list-b' });
    await mergedInto(loser, survivor);

    const after = await eventually(
      () => api().call('segments.members', { artifactId: list }),
      (r) => r.total === 1 && r.members.every((m) => m.profileId === survivor),
    );
    expect(after.members).toEqual([expect.objectContaining({ profileId: survivor, source: 'api', addedAt: expect.any(String) })]);
    expect(await api().call('segments.preview', { artifactId: list })).toMatchObject({ count: 1, sample: [survivor] });
    expect((await api().call('segments.ofProfile', { profileId: survivor })).segments.map((s) => s.id)).toContain(list);

    const rows = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ profile_id: string; source: string }>(
        sql`SELECT profile_id, source FROM segment_list_members
            WHERE workspace_id = ${ws} AND segment_id = ${list} ORDER BY profile_id`,
      ),
    );
    expect(rows.rows).toEqual([{ profile_id: survivor, source: 'api' }]);
    expect(
      await t.srv.db.withWorkspace(ws, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM segment_memberships
              WHERE workspace_id = ${ws} AND segment_id = ${list} AND profile_id = ${loser}`,
        ),
      ),
    ).toMatchObject({ rows: [{ n: 0 }] });

    // Adding the canonical person again is a no-op, not a duplicate.
    expect(await api().call('audiences.add', { segmentId: list, profileIds: [survivor] })).toMatchObject({ added: 0, existing: 1 });
    expect((await api().call('segments.members', { artifactId: list })).total).toBe(1);
  });

  it('keeps both people once and preserves the earlier addition when both were on the list', async () => {
    const survivor = await person({ userId: 'u-list-both' });
    const loser = await person({ anonymousId: 'anon-list-both' });
    const list = await createList('Shared list');
    await api().call('audiences.add', { segmentId: list, profileIds: [survivor] });
    await new Promise((r) => setTimeout(r, 5));
    await api().call('audiences.add', { segmentId: list, profileIds: [loser] });
    const addedAt = async (profileId: string) =>
      (
        await t.srv.db.withWorkspace(ws, (tx) =>
          tx.execute<{ added_at: Date }>(
            sql`SELECT added_at FROM segment_list_members
                WHERE workspace_id = ${ws} AND segment_id = ${list} AND profile_id = ${profileId}`,
          ),
        )
      ).rows[0].added_at;
    const survivorAdded = await addedAt(survivor);
    const loserAdded = await addedAt(loser);
    expect(new Date(loserAdded).getTime()).toBeGreaterThanOrEqual(new Date(survivorAdded).getTime());

    await merge({ userId: 'u-list-both', anonymousId: 'anon-list-both' });
    await mergedInto(loser, survivor);

    const members = await eventually(
      () => api().call('segments.members', { artifactId: list }),
      (r) => r.total === 1 && r.members.every((m) => m.profileId === survivor),
    );
    expect(members.total).toBe(1);
    expect(await addedAt(survivor)).toEqual(survivorAdded);
    expect(
      await t.srv.db.withWorkspace(ws, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM segment_list_members
              WHERE workspace_id = ${ws} AND segment_id = ${list} AND profile_id IN (${survivor}, ${loser})`,
        ),
      ),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });

  it('moves and deduplicates a snapshot membership, and a refresh keeps one canonical row', async () => {
    const survivor = await person({ userId: 'u-snap-a' }, { email: 'snap-a@example.com' });
    const loser = await person({ anonymousId: 'anon-snap-b' }, { plan: 'snapshot-only-v072' });
    const source = await api().call('artifacts.create', {
      type: 'segment',
      name: 'Pro plan',
      content: { condition: { trait: 'plan', op: 'eq', value: 'snapshot-only-v072' } },
    });
    await publish(source.artifactId);
    await eventually(
      () => api().call('segments.members', { artifactId: source.artifactId }),
      (r) => r.members.some((m) => m.profileId === loser),
    );
    const snapshot = await api().call('audiences.snapshot', { sourceSegmentId: source.artifactId, name: 'Pro snapshot' });
    expect(snapshot.members).toBe(1);
    expect((await api().call('segments.members', { artifactId: snapshot.artifactId })).members.map((m) => m.profileId)).toEqual([loser]);

    await merge({ userId: 'u-snap-a', anonymousId: 'anon-snap-b' });
    await mergedInto(loser, survivor);

    const moved = await eventually(
      () => api().call('segments.members', { artifactId: snapshot.artifactId }),
      (r) => r.total === 1 && r.members.every((m) => m.profileId === survivor),
    );
    expect(moved.members).toEqual([expect.objectContaining({ profileId: survivor, source: 'snapshot' })]);

    // The derived source membership is recomputed for the survivor (the snapshot itself is not
    // recomputed by the scheduler), so a refresh copies the same canonical person.
    await eventually(
      () => api().call('segments.members', { artifactId: source.artifactId }),
      (r) => r.members.some((m) => m.profileId === survivor),
    );
    // The snapshot's list and the materialized copy still hold exactly one row afterwards.
    const fresh = await api().call('audiences.refreshSnapshot', { segmentId: snapshot.artifactId });
    expect(fresh).toMatchObject({ members: 1, added: 0, removed: 0 });
    const rows = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM segment_memberships
            WHERE workspace_id = ${ws} AND segment_id = ${snapshot.artifactId}`,
      ),
    );
    expect(rows.rows).toEqual([{ n: 1 }]);
  });
});
