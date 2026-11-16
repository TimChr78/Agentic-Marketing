import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { schema } from '@agentic-marketing/db';
import { sendRequestHash } from '@agentic-marketing/email';
import type { BusEvent } from '@agentic-marketing/events';
import { applyEvents } from '@agentic-marketing/profiles';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #944: a broadcast's dedupe key embedded the mutable profile id, and identity resolution rewrites
// that id on a merge. A run that was mid-flight when two profiles of one person merged sent the
// survivor a second message, because the survivor's id missed the key and nobody looked at the
// message the person already had. The run now asks whether the *person* already has a message for
// this broadcast — under the member's id or under any profile it was merged into — on every pass.
// Journeys key on the participant id, which is why they were never affected.

const PORT = testPort(3503);
const PEOPLE = 5;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let template = '';

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const api = () => t.api(owner, ws);

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const identify = (body: Record<string, unknown>) => ingest([{ type: 'identify', ...body }]);

const createPublished = async (type: 'email_template' | 'segment' | 'broadcast', name: string, content: object) => {
  const a = await api().call('artifacts.create', { type, name, content });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'v01424 merge keys' });
  return a.artifactId;
};

const profileOf = async (lookup: { type: 'user_id' | 'anonymous_id'; value: string }) =>
  (
    await eventually(
      () => api().call('profiles.find', lookup),
      (r) => !!r.profileId,
    )
  ).profileId!;

interface MessageRow {
  id: string;
  profile_id: string | null;
  idempotency_key: string;
  status: string;
  request_hash: string | null;
}

const messagesOf = async (broadcastId: string): Promise<MessageRow[]> =>
  (
    await t.srv.db.admin.query<MessageRow>(
      `SELECT id, profile_id, idempotency_key, status, request_hash FROM messages
       WHERE workspace_id = $1 AND journey_id = $2 AND test = false ORDER BY id`,
      [ws, broadcastId],
    )
  ).rows;

const grant = async (profileIds: string[]) => {
  for (const profileId of profileIds) await api().call('consent.record', { profileId, purpose: 'marketing_email', status: 'granted' });
};

const mergedInto = (loser: string, survivor: string) =>
  eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ merged_into: string | null }>('SELECT merged_into FROM profiles WHERE workspace_id = $1 AND id = $2', [
          ws,
          loser,
        ])
      ).rows[0]?.merged_into ?? null,
    (id) => id === survivor,
  );

/** A static list holding exactly this test's people, and its published segment id. */
async function audienceOf(name: string, profileIds: string[]): Promise<string> {
  const segment = await createPublished('segment', `merge keys ${name}`, { mode: 'static' });
  await api().call('audiences.add', { segmentId: segment, profileIds });
  return segment;
}

/**
 * A broadcast pinned to a static list, published with a future sendAt so its run exists but is not
 * due: a test sets the run's cursor and due time itself, exactly as a chunk boundary or a crash
 * leaves them.
 */
async function scheduledBroadcast(name: string, segment: string): Promise<string> {
  const id = await createPublished('broadcast', name, {
    template,
    segment,
    sendAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM broadcast_runs WHERE workspace_id = $1 AND broadcast_id = $2',
          [ws, id],
        )
      ).rows[0]!.n,
    (n) => n === 1,
  );
  return id;
}

/** The state a chunk leaves behind: a cursor, a lease-free running run, and its due time passed. */
const startRunAt = (broadcastId: string, cursor: string) =>
  t.srv.db.admin.query(
    `UPDATE broadcast_runs SET send_at = now() - interval '1 minute', status = 'running', cursor = $3,
            lease_until = NULL, finished_at = NULL
     WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, broadcastId, cursor],
  );

const runRow = async (broadcastId: string) =>
  (
    await t.srv.db.admin.query<{ status: string; cursor: string }>(
      'SELECT status, cursor FROM broadcast_runs WHERE workspace_id = $1 AND broadcast_id = $2',
      [ws, broadcastId],
    )
  ).rows[0]!;

/** Waits for the tick that works through the run to finish, then the test counts what it wrote. */
const awaitDone = (broadcastId: string) =>
  eventually(
    () => runRow(broadcastId),
    (r) => r.status === 'done',
  );

/** A message row exactly as the send gateway writes one for a broadcast recipient. */
const chunkMessage = (broadcastId: string, profileId: string, requestHash: string | null) =>
  t.srv.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, template_id, template_version,
                           journey_id, status, request_hash)
     VALUES ($1, $2, $3, 'email', $4, 'marketing_email', $5, 1, $6, 'queued', $7)`,
    [ws, `msg_${profileId}`, `bct:${broadcastId}:${profileId}`, profileId, template, broadcastId, requestHash],
  );

const broadcastHash = (broadcastId: string, recipient: string) =>
  sendRequestHash('email', { caller: 'system:broadcast', recipient, broadcast: broadcastId });

/** Two profiles of one person, and the id-time pair that decides which one survives a merge. */
async function twoProfiles(suffix: string) {
  await identify({ anonymousId: `anon-${suffix}` });
  const anon = await profileOf({ type: 'anonymous_id', value: `anon-${suffix}` });
  await identify({ userId: `user-${suffix}`, traits: { email: `${suffix}@example.com` } });
  const user = await profileOf({ type: 'user_id', value: `user-${suffix}` });
  return { anon, user };
}

/** Makes `survivor` the older profile, so a merge of the two keeps it (the target is the oldest). */
const survivorIsOlder = (survivor: string, loser: string) =>
  t.srv.db.admin.query(
    `UPDATE profiles SET created_at = CASE WHEN id = $2 THEN now() - interval '20 minutes' ELSE now() END
     WHERE workspace_id = $1 AND id IN ($2, $3)`,
    [ws, survivor, loser],
  );

/**
 * Makes `survivor` the older profile so the merge keeps it (the target is the oldest profile), and
 * links the two through the anonymous id plus the e-mail only the user profile carries.
 */
async function mergeProfiles(suffix: string, survivor: string, loser: string) {
  await survivorIsOlder(survivor, loser);
  await identify({ anonymousId: `anon-${suffix}`, traits: { email: `${suffix}@example.com` } });
  await mergedInto(loser, survivor);
}

/**
 * A merge written but not committed, on its own connection: identity resolution takes the
 * workspace's identity advisory lock and holds it until the transaction ends, so a broadcast batch
 * has to queue behind it. The test commits when it wants the merge to land.
 */
async function heldMerge(suffix: string) {
  const client = await t.srv.db.app.connect();
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', ws]);
  const event: BusEvent = {
    workspaceId: ws,
    sourceId: 'src_merge_race',
    messageId: `msg-merge-race-${suffix}`,
    type: 'identify',
    name: 'identify',
    anonymousId: `anon-${suffix}`,
    userId: '',
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    properties: {},
    traits: {},
    piiTraits: { email: `${suffix}@example.com` },
    context: {},
    consent: {},
  };
  await applyEvents(drizzle(client, { schema }), ws, [event], {
    kp: t.srv.keyProvider,
    purposes: async (tx) => (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES,
  });
  return {
    async commit() {
      await client.query('COMMIT');
      client.release();
    },
    async rollback() {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    },
  };
}

/** Backends waiting on a transaction-scoped advisory lock; the dedicated database makes this exact. */
const advisoryWaiters = async () =>
  (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND NOT granted', ['advisory']))
    .rows[0]!.n;

beforeAll(async () => {
  t = await startTestServer('test_v01424_broadcast_merge', PORT);
  owner = await t.signUp(`owner-merge-keys-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  template = await createPublished('email_template', 'merge keys newsletter', {
    purpose: 'marketing_email',
    subject: 'One message per person',
    mjml: mjml('Hello {{ profile.firstName | default: "reader" }}'),
  });
}, 120_000);

afterAll(() => t?.close());

describe('a merge mid-broadcast still sends one message (#944)', () => {
  it('skips the survivor when the merged-away profile was sent and the survivor sorts after the cursor', async () => {
    const { anon, user } = await twoProfiles('merge-one');
    // The larger id survives (the test decides which is older), so the merged-away id comes first in
    // the run's id order and the survivor is exactly the id a chunk has not visited yet.
    const survivor = anon > user ? anon : user;
    const loser = survivor === anon ? user : anon;
    const segment = await audienceOf('one', [survivor, loser]);
    const id = await scheduledBroadcast('merge one', segment);
    await grant([survivor, loser]);

    // Chunk 1: the merged-away profile was queued and the cursor sits on it.
    await chunkMessage(id, loser, broadcastHash(id, loser));
    await mergeProfiles('merge-one', survivor, loser);
    // The merge moved the person's message to the survivor.
    expect((await messagesOf(id)).map((m) => m.profile_id)).toEqual([survivor]);

    await startRunAt(id, loser);
    await awaitDone(id);
    const mine = await messagesOf(id);
    expect(mine.map((m) => m.profile_id)).toEqual([survivor]);
  }, 90_000);

  it('skips a merged-away id the audience still lists after the merge', async () => {
    const { anon, user } = await twoProfiles('merge-two');
    // The smaller id survives and is the profile chunk 1 sent to; the merged-away id sorts after the
    // cursor and is still a member, so the next tick's batch visits it.
    const survivor = anon < user ? anon : user;
    const loser = survivor === anon ? user : anon;
    const segment = await audienceOf('two', [survivor, loser]);
    const id = await scheduledBroadcast('merge two', segment);
    await grant([survivor, loser]);

    await chunkMessage(id, survivor, broadcastHash(id, survivor));
    await mergeProfiles('merge-two', survivor, loser);
    // A static list row that still names the merged-away id (the list was imported before the merge
    // and a merge does not rewrite an imported file): the run visits a tombstone.
    await t.srv.db.admin.query(
      `INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, source) VALUES ($1, $2, $3, 'manual')
       ON CONFLICT DO NOTHING`,
      [ws, segment, loser],
    );
    await t.srv.db.admin.query(
      `INSERT INTO segment_memberships (workspace_id, segment_id, profile_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [ws, segment, loser],
    );

    await startRunAt(id, survivor);
    await awaitDone(id);
    const mine = await messagesOf(id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.profile_id).toBe(survivor);
  }, 90_000);

  it('does not resend a member a run queued before the upgrade', async () => {
    // A mid-run broadcast from 0.14.23 already has its members' messages under the old key shape
    // `bct:<broadcast>:<profile>`; a row from before 0.14.22 carries no request fingerprint at all.
    const profiles: string[] = [];
    for (const suffix of ['upgrade-fp', 'upgrade-null']) {
      await identify({ userId: suffix, traits: { email: `${suffix}@example.com` } });
      profiles.push(await profileOf({ type: 'user_id', value: suffix }));
    }
    const segment = await audienceOf('upgrade', profiles);
    const id = await scheduledBroadcast('upgrade', segment);
    await grant(profiles);
    await chunkMessage(id, profiles[0]!, broadcastHash(id, profiles[0]!));
    await chunkMessage(id, profiles[1]!, null);

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((m) => m.profile_id))).toEqual(new Set(profiles));
  }, 90_000);

  it('sends one message per member of a plain broadcast', async () => {
    const profiles: string[] = [];
    for (let i = 0; i < PEOPLE; i++) {
      await identify({ userId: `plain-${i}`, traits: { email: `plain-${i}@example.com` } });
      profiles.push(await profileOf({ type: 'user_id', value: `plain-${i}` }));
    }
    const segment = await audienceOf('plain', profiles);
    const id = await scheduledBroadcast('plain', segment);
    await grant(profiles);
    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(PEOPLE);
    expect(new Set(rows.map((m) => m.profile_id))).toEqual(new Set(profiles));
    expect(rows.every((m) => m.idempotency_key.startsWith(`bct:${id}:`))).toBe(true);
  }, 90_000);

  it('queues one message when the audience lists both aliases of a person', async () => {
    const { anon, user } = await twoProfiles('alias');
    const survivor = anon < user ? anon : user;
    const loser = survivor === anon ? user : anon;
    const segment = await audienceOf('alias', [survivor, loser]);
    const id = await scheduledBroadcast('alias', segment);
    await grant([survivor, loser]);
    await mergeProfiles('alias', survivor, loser);
    // A dynamic segment still holds both ids until its next refresh (and an imported list can name
    // a merged-away id for good), so one batch selects the person twice before anything was sent.
    await t.srv.db.admin.query(
      `INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, source) VALUES ($1, $2, $3, 'manual')
       ON CONFLICT DO NOTHING`,
      [ws, segment, loser],
    );
    await t.srv.db.admin.query(
      `INSERT INTO segment_memberships (workspace_id, segment_id, profile_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [ws, segment, loser],
    );

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profile_id).toBe(survivor);
    expect((await runRow(id)).status).toBe('done');
  }, 90_000);

  it('serialises with a merge that commits while the batch is looking at the person', async () => {
    const { anon, user } = await twoProfiles('race');
    const survivor = anon > user ? anon : user;
    const loser = survivor === anon ? user : anon;
    const segment = await audienceOf('race', [survivor, loser]);
    const id = await scheduledBroadcast('race', segment);
    await grant([survivor, loser]);
    // Chunk 1 queued the merged-away profile; its message is what a merge would move.
    await chunkMessage(id, loser, broadcastHash(id, loser));
    await survivorIsOlder(survivor, loser);

    // The merge is written and holds the identity lock, but is not committed yet.
    const merge = await heldMerge('race');
    try {
      await startRunAt(id, '');
      // The batch cannot check or queue for this person until the merge is resolved: it waits on the
      // identity lock the merge holds. (Before the fix it read past the uncommitted merge and
      // queued a second copy.) No sleep: the wait is visible in `pg_locks`.
      const waiting = await eventually(
        () => advisoryWaiters(),
        (n) => n >= 1,
        20_000,
      );
      expect(waiting, 'the batch waits on the identity lock the merge holds').toBeGreaterThanOrEqual(1);
    } finally {
      await merge.commit();
    }
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profile_id).toBe(survivor);
  }, 120_000);

  it('replays a chunk whose messages committed without its cursor, without duplicating', async () => {
    const profiles: string[] = [];
    for (let i = 0; i < 3; i++) {
      await identify({ userId: `replay-${i}`, traits: { email: `replay-${i}@example.com` } });
      profiles.push(await profileOf({ type: 'user_id', value: `replay-${i}` }));
    }
    const segment = await audienceOf('replay', profiles);
    const id = await scheduledBroadcast('replay', segment);
    await grant(profiles);
    // The first two already have the message a chunk queued; the run restarts from the top.
    await chunkMessage(id, profiles[0]!, broadcastHash(id, profiles[0]!));
    await chunkMessage(id, profiles[1]!, broadcastHash(id, profiles[1]!));
    const before = await messagesOf(id);

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((m) => m.profile_id))).toEqual(new Set(profiles));
    // The replay kept the rows the first attempt committed.
    for (const m of before) expect(rows.find((r) => r.profile_id === m.profile_id)?.id).toBe(m.id);
  }, 90_000);
});
