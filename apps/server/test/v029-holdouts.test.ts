import { outbox } from '@agentic-marketing/email';
import { armFor, holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// v0.2.9 (#67): control groups for journeys. Assignment is deterministic and recorded once per
// scope version; control people walk waits and goals but every channel step is skipped; results
// report lift with a Newcombe interval and refuse a verdict before the planned sample size.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let key: string;
let template: string;

const mjml = (body: string) => `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;
const api = () => t.api(owner);

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const profileIdOf = async (userId: string) =>
  (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;

const mailTo = (to: string) => outbox.filter((m) => m.to === to);

interface ParticipantRow {
  id: string;
  status: string;
  node: string;
  converted: boolean;
  context: { holdout?: { arm: string; hashVersion: string; percent: number } };
}
const participantOf = async (journeyId: string, profileId: string) =>
  (
    await t.srv.db.admin.query<ParticipantRow>(
      `SELECT id::text, status, node, converted, context FROM journey_participants
       WHERE journey_id = $1 AND profile_id = $2 ORDER BY id DESC LIMIT 1`,
      [journeyId, profileId],
    )
  ).rows[0];

const assignmentCount = async (journeyId: string) =>
  (
    await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM holdout_assignments WHERE workspace_id = $1 AND scope_type = 'journey' AND scope_id = $2`,
      [ws, journeyId],
    )
  ).rows[0]!.n;

const messagesTo = async (journeyId: string, profileId: string) =>
  (
    await t.srv.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE journey_id = $1 AND profile_id = $2`, [
      journeyId,
      profileId,
    ])
  ).rows[0]!.n;

const fastForward = (journeyId: string, profileId: string) =>
  t.srv.db.admin.query(`UPDATE journey_participants SET due_at = now() WHERE journey_id = $1 AND profile_id = $2 AND status = 'waiting'`, [
    journeyId,
    profileId,
  ]);

const journeyEvents = async (journeyId: string, profileId: string) => {
  const settings = await t.srv.events.settingsFor(ws);
  const rs = await t.srv.events.client.query({
    query: `SELECT type, detail FROM journey_events FINAL
            WHERE workspace_id = {ws:UUID} AND journey_id = {j:String} AND profile_id = {p:String}`,
    query_params: { ws, j: journeyId, p: profileId },
    format: 'JSONEachRow',
    clickhouse_settings: settings as never,
  });
  return rs.json<{ type: string; detail: string }>();
};

/** A minimal journey that mails once, waits, then counts a goal event. */
async function createJourney(
  name: string,
  opts: { percent?: number; minSampleSize?: number; reentry?: 'once' | 'always'; event?: string } = {},
) {
  const a = await api().call('artifacts.create', {
    type: 'journey',
    name,
    content: {
      purpose: 'onboarding',
      ...(opts.percent ? { controlGroup: { percent: opts.percent, minSampleSize: opts.minSampleSize ?? 200 } } : {}),
      nodes: [
        {
          id: 'trigger',
          kind: 'trigger',
          label: 'Start',
          config: { event: opts.event ?? 'Holdout Start', reentry: opts.reentry ?? 'once' },
        },
        { id: 'email', kind: 'email', label: 'Mail', config: { template }, next: [{ to: 'wait' }] },
        { id: 'wait', kind: 'wait', label: 'One day', config: { duration: 'P1D' }, next: [{ to: 'goal' }] },
        {
          id: 'goal',
          kind: 'goal',
          label: 'Goal',
          config: { event: 'Holdout Goal', within: 'P14D' },
          next: [{ to: 'done' }, { to: 'done' }],
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    } as never,
  });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

/** A journey with no messages, for synthetic measurement rows. */
async function createMeasurementJourney(name: string, percent: number, minSampleSize: number) {
  const a = await api().call('artifacts.create', {
    type: 'journey',
    name,
    content: {
      purpose: 'onboarding',
      controlGroup: { percent, minSampleSize },
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Measure Start', reentry: 'once' } },
        { id: 'wait', kind: 'wait', label: 'One day', config: { duration: 'P1D' } },
        {
          id: 'goal',
          kind: 'goal',
          label: 'Goal',
          config: { event: 'Measure Goal', within: 'P14D' },
          next: [{ to: 'done' }, { to: 'done' }],
        },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    } as never,
  });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

beforeAll(async () => {
  t = await startTestServer('test_v029_holdouts', testPort(3315));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await api().call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'hello@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const tpl = await api().call('artifacts.create', {
    type: 'email_template',
    name: 'Holdout mail',
    content: { purpose: 'onboarding', subject: 'Hello', mjml: mjml('Hello') },
  });
  template = tpl.artifactId;
  await api().call('artifacts.requestPublish', { artifactId: template, note: 'test' });
}, 60_000);
afterAll(() => t?.close());

describe('deterministic assignment (#67)', () => {
  it('keeps the same arm across re-entries and records one assignment', async () => {
    const journeyId = await createJourney('Re-entry', { percent: 50, reentry: 'always', event: 'Reentry Start' });
    const userId = 'holdout-reentry';
    await send([{ type: 'identify', userId, traits: { email: `${userId}@example.com` } }]);
    const profileId = await profileIdOf(userId);
    const hash = holdoutHashVersion(50);
    const expected = armFor(50, ws, journeyId, hash, profileId);

    await send([{ type: 'track', event: 'Reentry Start', userId }]);
    await eventually(
      () => assignmentCount(journeyId),
      (n) => n === 1,
    );
    await send([{ type: 'track', event: 'Reentry Start', userId }]);

    const participants = await eventually(
      async () =>
        (
          await t.srv.db.admin.query<ParticipantRow>(
            `SELECT id::text, status, node, converted, context FROM journey_participants
             WHERE journey_id = $1 AND profile_id = $2 ORDER BY id`,
            [journeyId, profileId],
          )
        ).rows,
      (rows) => rows.length === 2,
    );
    const [stored] = (
      await t.srv.db.admin.query<{ arm: string; hash_version: string }>(
        `SELECT arm, hash_version FROM holdout_assignments WHERE workspace_id = $1 AND scope_type = 'journey' AND scope_id = $2 AND profile_id = $3`,
        [ws, journeyId, profileId],
      )
    ).rows;
    expect(stored).toMatchObject({ arm: expected, hash_version: hash });
    expect(await assignmentCount(journeyId)).toBe(1);
    for (const p of participants) expect(p.context.holdout).toMatchObject({ arm: expected, hashVersion: hash, percent: 50 });

    // One immutable holdout event, not one per re-entry.
    const events = await eventually(
      () => journeyEvents(journeyId, profileId),
      (rows) => rows.some((r) => r.type === 'holdout_assigned'),
    );
    expect(events.filter((e) => e.type === 'holdout_assigned')).toHaveLength(1);
    expect(events.find((e) => e.type === 'holdout_assigned')!.detail).toContain(`arm=${expected}`);
  });
});

describe('treatment and control (#67)', () => {
  it('sends to treatment but skips every channel step for control, while both reach the goal', async () => {
    const journeyId = await createJourney('Arms', { percent: 50, event: 'Arms Start' });
    const hash = holdoutHashVersion(50);

    // The arm depends on the generated profile id, so identify first and pick one of each.
    const candidates = Array.from({ length: 12 }, (_, i) => `holdout-arm-${i}`);
    await send(candidates.map((userId) => ({ type: 'identify', userId, traits: { email: `${userId}@example.com` } })));
    const profiles = await Promise.all(candidates.map(async (userId) => ({ userId, profileId: await profileIdOf(userId) })));
    const control = profiles.find((p) => armFor(50, ws, journeyId, hash, p.profileId) === 'control')!;
    const treatment = profiles.find((p) => armFor(50, ws, journeyId, hash, p.profileId) === 'treatment')!;
    expect(control).toBeDefined();
    expect(treatment).toBeDefined();

    await send([
      { type: 'track', event: 'Arms Start', userId: control.userId },
      { type: 'track', event: 'Arms Start', userId: treatment.userId },
    ]);

    // Control walks past the e-mail node without a message; treatment gets one.
    const controlWaiting = await eventually(
      () => participantOf(journeyId, control.profileId),
      (p) => p?.node === 'wait',
    );
    expect(controlWaiting?.context.holdout?.arm).toBe('control');
    expect(await messagesTo(journeyId, control.profileId)).toBe(0);
    expect(mailTo(`${control.userId}@example.com`)).toHaveLength(0);

    await eventually(
      async () => mailTo(`${treatment.userId}@example.com`),
      (m) => m.length === 1,
    );
    expect(await messagesTo(journeyId, treatment.profileId)).toBeGreaterThan(0);

    // Both still take waits and branch to the goal when the goal event arrives.
    await fastForward(journeyId, control.profileId);
    await fastForward(journeyId, treatment.profileId);
    // The goal only counts events that arrive while the person waits at it: wait for the scheduler
    // to move both past the wait first, or the event can come too early and be missed.
    for (const p of [control, treatment])
      await eventually(
        () => participantOf(journeyId, p.profileId),
        (r) => r?.node === 'goal' && r.status === 'waiting',
      );
    await send([
      { type: 'track', event: 'Holdout Goal', userId: control.userId },
      { type: 'track', event: 'Holdout Goal', userId: treatment.userId },
    ]);
    for (const p of [control, treatment]) {
      const row = await eventually(
        () => participantOf(journeyId, p.profileId),
        (r) => r?.status === 'completed' && r.converted,
      );
      expect(row?.converted).toBe(true);
    }

    const controlEvents = await eventually(
      () => journeyEvents(journeyId, control.profileId),
      (rows) => rows.some((r) => r.type === 'converted'),
    );
    expect(controlEvents.some((e) => e.type === 'step' && e.detail === 'skipped: control')).toBe(true);
    expect(controlEvents.some((e) => e.type === 'converted')).toBe(true);

    // The result reads ClickHouse, which the sink fills asynchronously: wait for both conversions.
    await eventually(
      () => journeyEvents(journeyId, treatment.profileId),
      (rows) => rows.some((r) => r.type === 'converted'),
    );
    // Two assigned people cannot meet the default minimum of 200 per arm.
    const result = await api().call('journeys.holdoutResult', { journeyId });
    expect(result.minSampleSizeMet).toBe(false);
    expect(result.verdict).toBe('not_enough_data');
    expect(result.control.entered).toBeGreaterThan(0);
    expect(result.treatment.entered).toBeGreaterThan(0);
    expect(result.control.conversionRate).toBeCloseTo(1, 10);
    expect(result.treatment.conversionRate).toBeCloseTo(1, 10);
  });
});

describe('result statistics (#67)', () => {
  it('computes rates, lift and the Newcombe interval against a hand-computed example', async () => {
    const journeyId = await createMeasurementJourney('Measured', 50, 100);
    const people = Array.from({ length: 200 }, (_, i) => `measure-${i}`);
    await send(people.map((userId) => ({ type: 'identify', userId, traits: { email: `${userId}@example.com` } })));
    const profiles = await eventually(
      async () => {
        const { rows } = await t.srv.db.admin.query<{ value: string; profile_id: string }>(
          `SELECT i.value, i.profile_id FROM identifiers i WHERE i.workspace_id = $1 AND i.type = 'user_id' AND i.value LIKE 'measure-%'`,
          [ws],
        );
        return rows;
      },
      (rows) => rows.length === 200,
    );
    const byUser = new Map(profiles.map((r) => [r.value, r.profile_id]));
    const ids = people.map((u) => byUser.get(u)!);
    const control = ids.slice(0, 100);
    const treatment = ids.slice(100);
    const hash = holdoutHashVersion(50);
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       SELECT $1, 'journey', $2, $3, x, 'control' FROM unnest($4::text[]) AS x`,
      [ws, journeyId, hash, control],
    );
    await t.srv.db.admin.query(
      `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm)
       SELECT $1, 'journey', $2, $3, x, 'treatment' FROM unnest($4::text[]) AS x`,
      [ws, journeyId, hash, treatment],
    );
    const at = new Date().toISOString();
    const converted = [
      ...control.slice(0, 10).map((profileId, i) => ({ profileId, participantId: 1000 + i })),
      ...treatment.slice(0, 30).map((profileId, i) => ({ profileId, participantId: 2000 + i })),
    ];
    await t.srv.events.insertJourneyEvents(
      converted.map(({ profileId, participantId }) => ({
        workspaceId: ws,
        journeyId,
        version: 1,
        participantId,
        profileId,
        node: 'goal',
        type: 'converted' as const,
        seq: 1,
        at,
        detail: 'Measure Goal',
      })),
    );
    // The e-mail guardrail: five treatment people unsubscribed, none in control (which got no mail).
    await t.srv.events.insertMessageEvents(
      treatment.slice(0, 5).map((profileId, i) => ({
        workspaceId: ws,
        messageId: `msg-unsub-${i}`,
        eventId: `evt-unsub-${i}`,
        type: 'unsubscribed' as const,
        at,
        profileId,
        channel: 'email',
        purpose: 'onboarding',
        provider: 'log',
        templateId: template,
        templateVersion: 1,
        journeyId,
        reason: '',
        url: '',
      })),
    );

    const result = await api().call('journeys.holdoutResult', { journeyId });
    expect(result.control).toMatchObject({ entered: 100, converted: 10, unsubscribed: 0 });
    expect(result.treatment).toMatchObject({ entered: 100, converted: 30, unsubscribed: 5 });
    expect(result.control.conversionRate).toBeCloseTo(0.1, 10);
    expect(result.treatment.conversionRate).toBeCloseTo(0.3, 10);
    expect(result.control.unsubscribeRate).toBeCloseTo(0, 10);
    expect(result.treatment.unsubscribeRate).toBeCloseTo(0.05, 10);
    expect(result.absoluteLift).toBeCloseTo(0.2, 10);
    expect(result.relativeLift).toBeCloseTo(2, 10);
    expect(result.ci95![0]).toBeCloseTo(0.0900021, 6);
    expect(result.ci95![1]).toBeCloseTo(0.3057893, 6);
    expect(result.minSampleSizeMet).toBe(true);
    expect(result.verdict).toBe('treatment_better');
    expect(result.controlGroup).toMatchObject({ percent: 50, minSampleSize: 100, hashVersion: hash });
  });
});

describe('scope changes (#67)', () => {
  it('refuses a changed percentage after assignments, and allows it with reset', async () => {
    const journeyId = await createJourney('Scope', { percent: 10, minSampleSize: 1, event: 'Scope Start' });
    const userId = 'holdout-scope';
    await send([
      { type: 'identify', userId, traits: { email: `${userId}@example.com` } },
      { type: 'track', event: 'Scope Start', userId },
    ]);
    await eventually(
      () => assignmentCount(journeyId),
      (n) => n > 0,
    );

    const got = await api().call('artifacts.get', { artifactId: journeyId });
    const content = got.version.content as { controlGroup: { percent: number; minSampleSize: number; reset?: boolean } };
    const changed = { ...content, controlGroup: { ...content.controlGroup, percent: 20 } };
    await api().call('artifacts.updateDraft', { artifactId: journeyId, content: changed as never });
    const refused = await rejects(api().call('artifacts.requestPublish', { artifactId: journeyId, note: 'widen' }));
    expect(refused.message).toContain('controlGroup.reset: true');

    const reset = { ...content, controlGroup: { ...content.controlGroup, percent: 20, reset: true } };
    await api().call('artifacts.updateDraft', { artifactId: journeyId, content: reset as never });
    const published = await api().call('artifacts.requestPublish', { artifactId: journeyId, note: 'widen and reset' });
    expect(published.status).toBe('published');
  });
});

describe('profile merges (#67)', () => {
  it('moves the arm to the survivor, keeping the survivor’s own arm when it has one', async () => {
    // Two journeys so both merge paths run: in "inherit" only the merged-away profile has an arm,
    // in "keep" both do and the survivor's arm must win.
    const inherit = await createJourney('Merge inherit', { percent: 50, minSampleSize: 1, event: 'Merge Inherit' });
    const keep = await createJourney('Merge keep', { percent: 50, minSampleSize: 1, event: 'Merge Keep' });
    const hash = holdoutHashVersion(50);

    // Older logged-in customer (A) and a newer anonymous visitor (B).
    await send([{ type: 'identify', userId: 'merge-holdout', traits: { email: 'merge-holdout@example.com' } }]);
    const survivor = await profileIdOf('merge-holdout');
    await send([{ type: 'track', event: 'Merge Keep', userId: 'merge-holdout' }]);
    await eventually(
      () => assignmentCount(keep),
      (n) => n === 1,
    );
    const survivorArm = (
      await t.srv.db.admin.query<{ arm: string }>(
        `SELECT arm FROM holdout_assignments WHERE workspace_id = $1 AND scope_id = $2 AND profile_id = $3`,
        [ws, keep, survivor],
      )
    ).rows[0]!.arm;

    // B enters both journeys; A never enters "inherit".
    await send([
      { type: 'track', event: 'Merge Inherit', anonymousId: 'anon-merge-holdout' },
      { type: 'track', event: 'Merge Keep', anonymousId: 'anon-merge-holdout' },
    ]);
    const merged = await eventually(
      () => api().call('profiles.find', { type: 'anonymous_id', value: 'anon-merge-holdout' }),
      (r) => !!r.profileId,
    );
    const loser = merged.profileId!;
    expect(loser).not.toBe(survivor);
    // Both journeys assign B; only "keep" assigns A.
    await eventually(
      async () => (await assignmentCount(inherit)) + (await assignmentCount(keep)),
      (n) => n >= 3,
    );
    const loserArm = (
      await t.srv.db.admin.query<{ arm: string }>(
        `SELECT arm FROM holdout_assignments WHERE workspace_id = $1 AND scope_id = $2 AND profile_id = $3`,
        [ws, inherit, loser],
      )
    ).rows[0]!.arm;

    // Logging in merges the newer anonymous profile into the older customer.
    await send([{ type: 'identify', userId: 'merge-holdout', anonymousId: 'anon-merge-holdout' }]);
    await eventually(
      async () =>
        (
          await t.srv.db.admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM holdout_assignments WHERE workspace_id = $1 AND profile_id = $2`,
            [ws, loser],
          )
        ).rows[0]!.n,
      (n) => n === 0,
    );
    const inherited = (
      await t.srv.db.admin.query<{ arm: string }>(
        `SELECT arm FROM holdout_assignments WHERE workspace_id = $1 AND scope_id = $2 AND profile_id = $3`,
        [ws, inherit, survivor],
      )
    ).rows[0];
    const kept = (
      await t.srv.db.admin.query<{ arm: string }>(
        `SELECT arm FROM holdout_assignments WHERE workspace_id = $1 AND scope_id = $2 AND profile_id = $3`,
        [ws, keep, survivor],
      )
    ).rows[0];
    expect(inherited?.arm).toBe(loserArm);
    expect(kept?.arm).toBe(survivorArm);
    expect(await assignmentCount(inherit)).toBe(1);
    expect(await assignmentCount(keep)).toBe(1);
    // The hash is unaffected by the merge, so the survivor stays in the same scope version.
    expect(hash).toBe(holdoutHashVersion(50));
  });
});

describe('erasure (#67)', () => {
  it('removes the assignment with the profile', async () => {
    const journeyId = await createJourney('Erasure', { percent: 50, minSampleSize: 1, event: 'Erasure Start' });
    const userId = 'holdout-erase';
    await send([
      { type: 'identify', userId, traits: { email: `${userId}@example.com` } },
      { type: 'track', event: 'Erasure Start', userId },
    ]);
    const profileId = await profileIdOf(userId);
    await eventually(
      () => assignmentCount(journeyId),
      (n) => n === 1,
    );
    await api().call('profiles.erase', { profileId, reason: 'test erasure' });
    expect(await assignmentCount(journeyId)).toBe(0);
    expect((await t.srv.db.admin.query(`SELECT 1 FROM profiles WHERE id = $1`, [profileId])).rowCount).toBe(0);
  });
});

describe('journeys.splitResult (#313)', () => {
  it('reports each arm of a split and compares it with the first', async () => {
    const a = await api().call('artifacts.create', {
      type: 'journey',
      name: 'Split measured',
      content: {
        purpose: 'onboarding',
        nodes: [
          { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Split Start', reentry: 'once' }, next: [{ to: 'split' }] },
          { id: 'split', kind: 'split', label: 'A/B', config: { weights: [50, 50] }, next: [{ to: 'a' }, { to: 'b' }] },
          { id: 'a', kind: 'wait', label: 'A', config: { duration: 'P1D' }, next: [{ to: 'done' }] },
          { id: 'b', kind: 'wait', label: 'B', config: { duration: 'P2D' }, next: [{ to: 'done' }] },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      } as never,
    });
    await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
    const journeyId = a.artifactId;
    const at = new Date().toISOString();
    const people = Array.from({ length: 400 }, (_, i) => ({ participantId: 5000 + i, profileId: `prf_split_${i}`, arm: i < 200 ? 1 : 2 }));
    const base = { workspaceId: ws, journeyId, version: 1, seq: 1, at };
    await t.srv.events.insertJourneyEvents(
      people.map((p) => ({
        ...base,
        participantId: p.participantId,
        profileId: p.profileId,
        node: 'split',
        type: 'step' as const,
        detail: `variant ${p.arm}`,
      })),
    );
    // 20 of arm 0 convert, 60 of arm 1.
    const converted = [...people.slice(0, 20), ...people.slice(200, 260)];
    await t.srv.events.insertJourneyEvents(
      converted.map((p) => ({
        ...base,
        participantId: p.participantId,
        profileId: p.profileId,
        node: 'done',
        type: 'converted' as const,
        detail: 'Split Goal',
      })),
    );

    const r = await eventually(
      () => api().call('journeys.splitResult', { journeyId, node: 'split', minSampleSize: 100 }),
      (x) => x.arms.reduce((n, arm) => n + arm.entered, 0) === 400,
    );
    expect(r.arms).toMatchObject([
      { arm: 0, weight: 50, entered: 200, converted: 20 },
      { arm: 1, weight: 50, entered: 200, converted: 60 },
    ]);
    expect(r.comparisons[0]).toMatchObject({ arm: 1, versus: 0, verdict: 'treatment_better', minSampleSizeMet: true });
    expect(r.note).toContain('arm 1 converts better');
    expect((await rejects(api().call('journeys.splitResult', { journeyId, node: 'a' }))).message).toContain('not a split');
  });
});
