import { randomUUID } from 'node:crypto';
import { schema } from '@agentic-marketing/db';
import type { EventBus, MessageEvent } from '@agentic-marketing/events';
import { audienceTestHooks, contextFor, evaluate, publishedSegments, runSegmentScheduler } from '@agentic-marketing/segments';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Wave 0.17.1 segment fixes: saved message windows are bounded, message counts are distinct
// messages, static lists follow a merge that lands while a write is in flight, one broken segment
// cannot take the workspace's other segments (or an unsubscribe response) down with it, and the
// builder says what the count and the refresh mean.

const today = () => Date.now();
const daysAgo = (days: number) => new Date(today() - days * 86_400_000).toISOString();

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';

const api = () => t.api(owner, ws);

beforeAll(async () => {
  t = await startTestServer('test_v0171_segments', testPort(4470));
  owner = await t.signUp(`segments-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 90_000);

afterAll(() => t?.close());

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

async function person(userId: string, traits: Record<string, unknown> = {}) {
  await send([{ type: 'identify', userId, traits }]);
  return (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;
}

async function createSegment(name: string, condition: unknown) {
  const a = await api().call('artifacts.create', { type: 'segment', name, content: { mode: 'dynamic', condition } });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId as string;
}

const msg = (profileId: string, kind: MessageEvent['type'], at: string, over: Partial<MessageEvent> = {}): MessageEvent => ({
  workspaceId: ws,
  messageId: `msg_${profileId}_${kind}_${at}`,
  eventId: `evt_${profileId}_${kind}_${at}_${over.messageId ?? ''}_${over.eventId ?? ''}`,
  type: kind,
  at,
  profileId,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: '',
  templateVersion: 1,
  journeyId: '',
  reason: '',
  url: '',
  ...over,
});

/** A published segment written directly, so a definition an older release saved can be replayed. */
async function seedPublishedSegment(workspaceId: string, content: unknown, mode: 'dynamic' | 'static' = 'dynamic'): Promise<string> {
  const id = `seg_${randomUUID().replaceAll('-', '')}`;
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'segment', $3, 1, 1)`,
    [workspaceId, id, `Segment ${id.slice(-6)}`],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3::jsonb, 'hash', 'user', 'test')`,
    [workspaceId, id, JSON.stringify({ description: '', mode, condition: content })],
  );
  return id;
}

describe('saving a message window (#1073, #1076)', () => {
  it('caps every window at 10 years and a new message window at the 25 months of stored history', async () => {
    let seq = 0;
    const create = (condition: unknown) =>
      api().call('artifacts.create', {
        type: 'segment',
        name: `Window ${++seq}`,
        content: { mode: 'dynamic', condition },
      });
    const refusal = async (condition: unknown) => {
      const error = await rejects(create(condition));
      expect(error.status).toBe(400);
      return error.message;
    };

    // Nothing bounds what an agent could write before this: P99999999D has no meaning ClickHouse
    // can bind, and the segment failed on every evaluation, forever.
    expect(await refusal({ message: 'opened', within: 'P99999999D' })).toMatch(/at most 10 years/);
    expect(await refusal({ event: 'Product Viewed', within: 'P9999D' })).toMatch(/at most 10 years/);
    // Past the 25-month TTL the oldest rows are silently gone, so a new window is refused.
    expect(await refusal({ message: 'opened', within: 'P1095D' })).toMatch(/25 months/);

    // The longest accepted windows and a message rule with no window still save (saved segments
    // without a window must keep working).
    await expect(create({ event: 'Product Viewed', within: 'P3650D' })).resolves.toMatchObject({
      artifactId: expect.stringMatching(/^seg_/),
    });
    await expect(create({ message: 'opened', within: 'P758D' })).resolves.toMatchObject({
      artifactId: expect.stringMatching(/^seg_/),
    });
    // 758 days is the shortest 25-month calendar span; one day more is refused.
    expect(await refusal({ message: 'opened', within: 'P759D' })).toMatch(/25 months/);
    await expect(create({ message: 'clicked', count: { gte: 2 } })).resolves.toMatchObject({
      artifactId: expect.stringMatching(/^seg_/),
    });
  }, 60_000);

  it('keeps a legacy over-10-year definition readable by members, and refuses preview with the fix (#1073)', async () => {
    const member = await person('v0171-legacy');
    const legacy = await seedPublishedSegment(ws, { message: 'opened', within: 'P99999999D' });
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.segmentMemberships).values({ workspaceId: ws, segmentId: legacy, profileId: member }),
    );

    // Stored membership is data: a definition that no longer parses must not turn this read into a 500.
    const members = await api().call('segments.members', { artifactId: legacy });
    expect(members.members.map((m) => m.profileId)).toEqual([member]);

    // Preview by id evaluates the rule, so it says what to fix instead of throwing a ZodError.
    const error = await rejects(api().call('segments.preview', { artifactId: legacy }));
    expect(error.status).toBe(400);
    expect(error.message).toBe('This segment has a window longer than 10 years; re-save it with a window of at most 10 years');
  }, 60_000);
});

describe('a message count is a count of messages (#1072)', () => {
  it('counts one message once when the pixel was fetched twice, in SQL and in memory', async () => {
    const ann = await person('v0171-ann', { city: 'Aarhus' });
    const ben = await person('v0171-ben', { city: 'Odense' });
    const same = `msg_${ann}_issue_41`;
    await t.srv.events.insertMessageEvents([
      msg(ann, 'opened', daysAgo(1), { messageId: same, eventId: 'evt_ann_open_1' }),
      msg(ann, 'opened', daysAgo(1), { messageId: same, eventId: 'evt_ann_open_2' }),
      msg(ann, 'opened', daysAgo(2), { messageId: `msg_${ann}_issue_42`, eventId: 'evt_ann_open_3' }),
      msg(ben, 'opened', daysAgo(1), { messageId: `msg_${ben}_issue_41`, eventId: 'evt_ben_open_1' }),
    ]);

    const people = (sample: string[]) => [...sample].sort();
    expect((await api().call('segments.preview', { condition: { message: 'opened' } })).count).toBe(2);
    // Two opens of one issue are one message, so "at least twice" is only Ann (two issues).
    expect(people((await api().call('segments.preview', { condition: { message: 'opened', count: { gte: 2 } } })).sample)).toEqual([ann]);

    // The in-memory path (journeys' wait-until) reads the same counts.
    const matched = await t.srv.db.withWorkspace(ws, async (tx) => {
      const all = await publishedSegments(tx);
      const ctx = contextFor(tx, ws, t.srv.events, all);
      const set = await evaluate({ message: 'opened', count: { gte: 2 } }, { ...ctx, scope: [ann, ben] });
      return [...set].sort();
    });
    expect(matched).toEqual([ann]);
  }, 60_000);
});

describe('one broken segment does not reach the reader or stop the others (#1073)', () => {
  it('keeps a committed unsubscribe a success and still moves the consent segment', async () => {
    const subscriber = await person('v0171-subscriber', { email: 'v0171-subscriber@example.com' });
    await api().call('consent.record', {
      profileId: subscriber,
      purpose: 'marketing_email',
      channel: 'email',
      status: 'granted',
      source: 'api',
      proof: { test: true },
    });

    // A message condition whose purpose key is syntactically valid but not published: the artifact
    // saves and publishes, and only evaluation throws.
    await createSegment('Broken engagement rule', { message: 'opened', purpose: 'not_a_published_purpose' });
    const consentSegment = await createSegment('Consented readers', { consent: 'marketing_email' });
    await api().call('segments.refresh', { artifactId: consentSegment });
    expect((await api().call('segments.members', { artifactId: consentSegment })).total).toBe(1);

    const token = t.srv.email.links.sign({ w: ws, p: subscriber, u: 'marketing_email', m: 'msg_v0171' });
    const res = await fetch(`${t.base}/u/${token}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await api().call('consent.history', { profileId: subscriber })).records.at(-1)).toMatchObject({
      purpose: 'marketing_email',
      status: 'withdrawn',
    });

    // The re-evaluation after the withdrawal evaluated the broken segment too. It failed on its own
    // and was rolled back to its savepoint; the consent segment's change committed.
    const live = await api().call('segments.preview', { artifactId: consentSegment });
    expect(live.count).toBe(0);
    // `segments.members.total` for a dynamic segment is the last full refresh's count (the row the
    // scheduler writes); the stored membership itself is what a send reads.
    await eventually(
      () => api().call('segments.members', { artifactId: consentSegment }),
      (r) => r.members.length === 0,
      15_000,
    );
    expect((await api().call('segments.members', { artifactId: consentSegment })).members).toEqual([]);
  }, 90_000);
});

describe('the scheduler isolates a failing segment (#1073)', () => {
  async function seedWorkspace(): Promise<string> {
    const workspace = await t.workspaceWith([[owner, 'owner']], 'none');
    await t.srv.db.withWorkspace(workspace, (tx) =>
      tx.insert(schema.profiles).values({
        workspaceId: workspace,
        id: `prf_${randomUUID().replaceAll('-', '')}`,
        traits: { city: 'Aarhus' },
      }),
    );
    return workspace;
  }

  const runOf = async (workspaceId: string, segmentId: string) => {
    const { rows } = await t.srv.db.admin.query<{ members: number }>(
      'SELECT members FROM segment_runs WHERE workspace_id = $1 AND segment_id = $2',
      [workspaceId, segmentId],
    );
    return rows[0]?.members;
  };

  it('refreshes every workspace around a broken definition, and skips an unparseable saved one', async () => {
    const cases: { workspace: string; good: string; broken: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const workspace = await seedWorkspace();
      // A syntactically valid purpose that is not published: the segment saves and publishes and
      // throws only when it is evaluated.
      const broken = await seedPublishedSegment(workspace, { message: 'opened', purpose: 'not_a_published_purpose' });
      const good = await seedPublishedSegment(workspace, { trait: 'city', op: 'eq', value: 'Aarhus' });
      cases.push({ workspace, good, broken });
    }
    // A definition saved before the 10-year cap no longer parses: it must fail only itself.
    const legacy = await seedWorkspace();
    const legacyGood = await seedPublishedSegment(legacy, { trait: 'city', op: 'eq', value: 'Aarhus' });
    const legacyBad = await seedPublishedSegment(legacy, { message: 'opened', within: 'P99999999D' });
    cases.push({ workspace: legacy, good: legacyGood, broken: legacyBad });

    const stop = new AbortController();
    const running = runSegmentScheduler(
      {
        db: t.srv.db,
        events: t.srv.events,
        bus: { publish: async () => undefined } as unknown as EventBus,
        everyMs: 0,
        tickMs: 50,
      },
      stop.signal,
    );
    try {
      const settled = await eventually(
        async () => {
          for (const c of cases) if ((await runOf(c.workspace, c.good)) !== 1) return false;
          return true;
        },
        (ok) => ok,
        30_000,
      );
      expect(
        settled,
        `healthy segments should all have refreshed; runs: ${JSON.stringify(
          await Promise.all(cases.map((c) => runOf(c.workspace, c.good))),
        )}`,
      ).toBe(true);
    } finally {
      stop.abort();
      await running;
    }

    for (const c of cases) {
      expect(await runOf(c.workspace, c.broken)).toBeUndefined();
      expect(await runOf(c.workspace, c.good)).toBe(1);
      const members = await t.srv.db.admin.query('SELECT 1 FROM segment_memberships WHERE workspace_id = $1 AND segment_id = $2', [
        c.workspace,
        c.good,
      ]);
      expect(members.rowCount).toBe(1);
    }
  }, 120_000);
});

describe('a static list write follows a merge that lands in between (#1068)', () => {
  it('locks the canonical rows and follows a merge that commits between the unlocked read and the lock', async () => {
    await send([{ type: 'identify', anonymousId: 'v0171-race-anon' }]);
    await send([{ type: 'identify', userId: 'v0171-race-user' }]);
    const anon = (
      await eventually(
        () => api().call('profiles.find', { type: 'anonymous_id', value: 'v0171-race-anon' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    const user = (
      await eventually(
        () => api().call('profiles.find', { type: 'user_id', value: 'v0171-race-user' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    // The merge keeps the older profile; the newer one is the id that will be folded away.
    const { rows } = await t.srv.db.admin.query<{ id: string }>(
      'SELECT id FROM profiles WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY created_at, id',
      [ws, [anon, user]],
    );
    const loser = rows.at(-1)!.id;
    expect(rows).toHaveLength(2);

    const list = await api().call('artifacts.create', { type: 'segment', name: 'Race list', content: { mode: 'static' } });
    let reached!: () => void;
    let release!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Pause the add after its unlocked follow, before `FOR SHARE`, and commit a merge in that window.
    audienceTestHooks.beforeRowLocks = async () => {
      reached();
      await gate;
    };
    try {
      const add = api().call('audiences.add', { segmentId: list.artifactId, profileIds: [loser] });
      await atGate;
      const merge = send([{ type: 'identify', userId: 'v0171-race-user', anonymousId: 'v0171-race-anon' }]);
      const merged = await eventually(
        () => t.srv.db.admin.query<{ merged_into: string | null }>('SELECT merged_into FROM profiles WHERE id = $1', [loser]),
        (r) => !!r.rows[0]?.merged_into,
        20_000,
      );
      const survivor = merged.rows[0]!.merged_into!;
      expect(survivor).not.toBe(loser);

      release();
      await add;
      await merge;

      const listed = await t.srv.db.withWorkspace(ws, (tx) =>
        tx
          .select({ profileId: schema.segmentListMembers.profileId })
          .from(schema.segmentListMembers)
          .where(eq(schema.segmentListMembers.segmentId, list.artifactId)),
      );
      expect(listed.map((r) => r.profileId)).toEqual([survivor]);
      expect((await api().call('segments.members', { artifactId: list.artifactId })).members.map((m) => m.profileId)).toEqual([survivor]);
    } finally {
      delete audienceTestHooks.beforeRowLocks;
      release();
    }
  }, 120_000);
});
