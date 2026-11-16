import { armFor, holdoutHashVersion } from '@agentic-marketing/artifacts';
import { sendRequestHash } from '@agentic-marketing/email';
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

const createPublished = async (type: 'email_template' | 'segment' | 'broadcast' | 'campaign', name: string, content: object) => {
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
  reason: string | null;
  request_hash: string | null;
}

const messagesOf = async (broadcastId: string): Promise<MessageRow[]> =>
  (
    await t.srv.db.admin.query<MessageRow>(
      `SELECT id, profile_id, idempotency_key, status, reason, request_hash FROM messages
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

const campaignContent = (percent: number, broadcastId?: string) => ({
  startsAt: '2026-01-01T00:00:00.000Z',
  goal: { kind: 'conversion' as const, event: 'Order Completed', attributionDays: 7 },
  controlGroup: { percent, minSampleSize: 1 },
  members: broadcastId ? [{ artifactId: broadcastId, role: 'primary' as const }] : [],
});

/** A published campaign whose control group covers the broadcast, so the run assigns arms. */
const campaignFor = (broadcastId: string, name: string) =>
  createPublished('campaign', `merge keys ${name}`, campaignContent(50, broadcastId));

/**
 * A published campaign whose percentage hashes `profileId` to `arm`: picked from the campaign's own
 * id before publishing, so a stale-arm test does not depend on the 50% bucket. With 50 possible
 * percentages the loop effectively always finds one.
 */
async function campaignHashingTo(name: string, profileId: string, arm: 'control' | 'treatment', broadcastId?: string) {
  const draft = await api().call('artifacts.create', {
    type: 'campaign',
    name: `merge keys ${name}`,
    content: campaignContent(1, broadcastId),
  });
  let percent = 0;
  for (let p = 1; p <= 50; p++)
    if (armFor(p, ws, draft.artifactId, holdoutHashVersion(p), profileId) === arm) {
      percent = p;
      break;
    }
  expect(percent, `a control percentage that hashes ${profileId} to ${arm}`).toBeGreaterThan(0);
  await api().call('artifacts.updateDraft', { artifactId: draft.artifactId, content: campaignContent(percent, broadcastId) });
  await api().call('artifacts.requestPublish', { artifactId: draft.artifactId, note: 'merge keys holdout arm' });
  return { campaign: draft.artifactId, hashVersion: holdoutHashVersion(percent), percent };
}

/** Assigns campaign arms directly, so the test decides them (and their times) instead of the hash. */
const assignCampaignArms = (campaign: string, hashVersion: string, rows: { profile: string; arm: 'control' | 'treatment'; at?: Date }[]) =>
  t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x.profile, x.arm, COALESCE(x.at, now())
     FROM unnest($4::text[], $5::text[], $6::timestamptz[]) AS x(profile, arm, at)`,
    [ws, campaign, hashVersion, rows.map((r) => r.profile), rows.map((r) => r.arm), rows.map((r) => r.at ?? null)],
  );

const campaignAssignments = async (campaign: string) =>
  (
    await t.srv.db.admin.query<{ profile_id: string; arm: string; assigned_at: Date }>(
      `SELECT profile_id, arm, assigned_at FROM holdout_assignments
       WHERE workspace_id = $1 AND scope_type = 'campaign' AND scope_id = $2 ORDER BY profile_id`,
      [ws, campaign],
    )
  ).rows;

/** A static list keeps a merged-away id after the merge, as an audience imported before it does. */
const keepAliasInAudience = async (segment: string, alias: string) => {
  await t.srv.db.admin.query(
    `INSERT INTO segment_list_members (workspace_id, segment_id, profile_id, source) VALUES ($1, $2, $3, 'manual')
     ON CONFLICT DO NOTHING`,
    [ws, segment, alias],
  );
  await t.srv.db.admin.query(
    `INSERT INTO segment_memberships (workspace_id, segment_id, profile_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [ws, segment, alias],
  );
};

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

  it('holds out the survivor even when the stale alias would be treatment', async () => {
    const { anon, user } = await twoProfiles('holdout-control');
    // The larger id survives, so the stale alias sorts first and is the batch's first member.
    const survivor = anon > user ? anon : user;
    const alias = survivor === anon ? user : anon;
    const segment = await audienceOf('holdout-control', [survivor, alias]);
    const id = await scheduledBroadcast('holdout-control', segment);
    await grant([survivor, alias]);
    const campaign = await campaignFor(id, 'holdout control');
    await mergeProfiles('holdout-control', survivor, alias);
    await keepAliasInAudience(segment, alias);
    // The person (under the survivor) is control, decided first; the stale alias's later treatment
    // row is not a second decision for them.
    await assignCampaignArms(campaign, holdoutHashVersion(50), [
      { profile: survivor, arm: 'control', at: new Date(Date.now() - 7_200_000) },
      { profile: alias, arm: 'treatment', at: new Date(Date.now() - 3_600_000) },
    ]);

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profile_id).toBe(survivor);
    expect(rows[0]!.status).toBe('suppressed');
    expect(rows[0]!.reason).toContain('holdout_control');
    expect(rows[0]!.idempotency_key).toBe(`bctc:${id}:${survivor}`);
  }, 90_000);

  it('sends to the survivor even when the stale alias was held out', async () => {
    const { anon, user } = await twoProfiles('holdout-send');
    const survivor = anon > user ? anon : user;
    const alias = survivor === anon ? user : anon;
    const segment = await audienceOf('holdout-send', [survivor, alias]);
    const id = await scheduledBroadcast('holdout-send', segment);
    await grant([survivor, alias]);
    const campaign = await campaignFor(id, 'holdout send');
    await mergeProfiles('holdout-send', survivor, alias);
    await keepAliasInAudience(segment, alias);
    // The person's own (earlier) decision is treatment and must send; the stale alias's later
    // control row does not move them into the holdout.
    await assignCampaignArms(campaign, holdoutHashVersion(50), [
      { profile: survivor, arm: 'treatment', at: new Date(Date.now() - 7_200_000) },
      { profile: alias, arm: 'control', at: new Date(Date.now() - 3_600_000) },
    ]);

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profile_id).toBe(survivor);
    expect(rows[0]!.status).not.toBe('suppressed');
    // The run read the survivor's arm; it did not add or move an assignment for the alias.
    expect((await campaignAssignments(campaign)).map((a) => [a.profile_id, a.arm])).toEqual(
      expect.arrayContaining([
        [survivor, 'treatment'],
        [alias, 'control'],
      ]),
    );
    expect((await campaignAssignments(campaign)).length).toBe(2);
  }, 90_000);

  it('inherits a control arm recorded on a merged-away alias', async () => {
    const { anon, user } = await twoProfiles('alias-arm');
    const survivor = anon > user ? anon : user;
    const alias = survivor === anon ? user : anon;
    const segment = await audienceOf('alias-arm', [survivor, alias]);
    const id = await scheduledBroadcast('alias-arm', segment);
    await grant([survivor, alias]);
    await mergeProfiles('alias-arm', survivor, alias);
    await keepAliasInAudience(segment, alias);
    // The campaign hashes the survivor to treatment: only the arm a 0.14.23 run recorded on the
    // stale alias (before the run used the canonical person) says this person is held out.
    const { campaign, hashVersion } = await campaignHashingTo('alias arm', survivor, 'treatment', id);
    await assignCampaignArms(campaign, hashVersion, [{ profile: alias, arm: 'control', at: new Date(Date.now() - 7_200_000) }]);

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('suppressed');
    expect(rows[0]!.reason).toContain('holdout_control');
    expect(rows[0]!.idempotency_key).toBe(`bctc:${id}:${survivor}`);
    // The inherited control arm is the person's arm: no freshly hashed treatment row, and it is
    // recorded under the survivor as well so later reads need no alias.
    const arms = await campaignAssignments(campaign);
    expect(arms.filter((a) => a.arm === 'treatment')).toEqual([]);
    expect(arms.map((a) => [a.profile_id, a.arm])).toEqual(
      expect.arrayContaining([
        [alias, 'control'],
        [survivor, 'control'],
      ]),
    );
    expect(arms).toHaveLength(2);
  }, 90_000);

  it('takes the earliest arm when a stale alias and the survivor disagree', async () => {
    const { anon, user } = await twoProfiles('alias-early');
    const survivor = anon > user ? anon : user;
    const alias = survivor === anon ? user : anon;
    const segment = await audienceOf('alias-early', [survivor, alias]);
    const id = await scheduledBroadcast('alias-early', segment);
    await grant([survivor, alias]);
    const campaign = await campaignFor(id, 'alias early');
    await mergeProfiles('alias-early', survivor, alias);
    await keepAliasInAudience(segment, alias);
    // Two rows that disagree: the alias was held out first, the survivor's later row says treatment.
    await assignCampaignArms(campaign, holdoutHashVersion(50), [
      { profile: alias, arm: 'control', at: new Date(Date.now() - 7_200_000) },
      { profile: survivor, arm: 'treatment', at: new Date(Date.now() - 3_600_000) },
    ]);

    await startRunAt(id, '');
    await awaitDone(id);
    const rows = await messagesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('suppressed');
    expect(rows[0]!.reason).toContain('holdout_control');
    expect(rows[0]!.idempotency_key).toBe(`bctc:${id}:${survivor}`);
  }, 90_000);

  it('counts a person once in the holdout result when an arm sits on a merged-away id', async () => {
    const campaign = await createPublished('campaign', 'merge keys counted once', campaignContent(50));
    const hashVersion = holdoutHashVersion(50);
    // Six people held out, seven rows: one person's arm is also stored under a profile they were
    // merged from. Five in treatment, so both arms clear k and the counts are visible.
    const control: string[] = [];
    for (let i = 0; i < 5; i++) {
      await identify({ userId: `counted-control-${i}`, traits: { email: `counted-control-${i}@example.com` } });
      control.push(await profileOf({ type: 'user_id', value: `counted-control-${i}` }));
    }
    const { anon, user } = await twoProfiles('counted-dup');
    const survivor = anon > user ? anon : user;
    const alias = survivor === anon ? user : anon;
    await mergeProfiles('counted-dup', survivor, alias);
    control.push(survivor);
    const treatment: string[] = [];
    for (let i = 0; i < 5; i++) {
      await identify({ userId: `counted-treatment-${i}`, traits: { email: `counted-treatment-${i}@example.com` } });
      treatment.push(await profileOf({ type: 'user_id', value: `counted-treatment-${i}` }));
    }
    await assignCampaignArms(campaign, hashVersion, [
      ...control.map((profile) => ({ profile, arm: 'control' as const })),
      { profile: alias, arm: 'control' as const },
      ...treatment.map((profile) => ({ profile, arm: 'treatment' as const })),
    ]);

    const result = await api().call('campaigns.holdoutResult', { campaignId: campaign });
    expect(result.control.entered).toBe(6);
    expect(result.treatment.entered).toBe(5);
    expect(result.suppressed).toBe(false);
  }, 90_000);

  it('moves a merged-away alias’s assignment to the survivor on merge', async () => {
    const { anon, user } = await twoProfiles('merge-arm');
    const survivor = anon > user ? anon : user;
    const alias = survivor === anon ? user : anon;
    const campaign = await createPublished('campaign', 'merge keys carry arm', campaignContent(50));
    const at = new Date(Date.now() - 3_600_000);
    await assignCampaignArms(campaign, holdoutHashVersion(50), [{ profile: alias, arm: 'control', at }]);
    await mergeProfiles('merge-arm', survivor, alias);

    // Profile merges already carry the arm to the survivor (migration 0041): one row, same arm, the
    // original time, and nothing left on the merged-away id.
    const arms = await campaignAssignments(campaign);
    expect(arms).toHaveLength(1);
    expect(arms[0]!.profile_id).toBe(survivor);
    expect(arms[0]!.arm).toBe('control');
    expect(new Date(arms[0]!.assigned_at).getTime()).toBe(at.getTime());
  }, 90_000);

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
