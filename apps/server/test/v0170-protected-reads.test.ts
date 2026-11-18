import { evaluateAlerts } from '@agentic-marketing/alerts';
import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import { newId } from '@agentic-marketing/core';
import type { BusEvent, JourneyEvent, MessageEvent } from '@agentic-marketing/events';
import { matchesCondition } from '@agentic-marketing/journeys';
import { runErasureCleanupOnce } from '@agentic-marketing/profiles';
import { readDataset } from '@agentic-marketing/warehouse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1037 part 2, end to end: after an erasure's exclusions are published, every application reader
// excludes the erased person — including rows written after the erasure completed. The rows are
// inserted through the production event store, so their subject hashes are the writer's own.

const PORT = testPort(3571);
const DB = 'test_v0170_protected_reads';
const stamp = Date.now();
const AT = '2026-11-10T10:00:00.000Z';
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-30T00:00:00.000Z';
const JOURNEY = 'jrn_0000000000000000000000000000aaa1';
const TEMPLATE = 'eml_0000000000000000000000000000aaa1';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let erasedProfile = '';
let liveProfile = '';
let erasedAnonymous = '';
let liveAnonymous = '';
let MEMBER = '';

let seq = 0;
const event = (over: Partial<BusEvent>): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_protected',
  messageId: `evt-${stamp}-${seq++}`,
  type: 'track',
  name: 'Purchase',
  anonymousId: '',
  userId: '',
  profileId: '',
  timestamp: AT,
  receivedAt: AT,
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const messageEvent = (over: Partial<MessageEvent>): MessageEvent => ({
  workspaceId: ws,
  messageId: MEMBER,
  eventId: `me-${stamp}-${seq++}`,
  type: 'sent',
  at: AT,
  profileId: '',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'test',
  templateId: TEMPLATE,
  templateVersion: 1,
  journeyId: MEMBER,
  reason: '',
  url: '',
  ...over,
});

const journeyEvent = (over: Partial<JourneyEvent>): JourneyEvent => ({
  workspaceId: ws,
  journeyId: JOURNEY,
  version: 1,
  participantId: 1,
  profileId: '',
  node: 'start',
  type: 'entered',
  seq: 1,
  at: AT,
  detail: '',
  ...over,
});

/** Runs cleanup rounds until every job is complete; no clock waits in the test. */
async function completeErasures() {
  for (let round = 0; round < 8; round++) {
    const result = await runErasureCleanupOnce(
      { db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, hot: t.srv.hot },
      { finalSweepMs: 0 },
    );
    if (!result.claimed) break;
    await t.srv.db.admin.query("UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1 AND state <> 'complete'", [
      ws,
    ]);
  }
  const { rows } = await t.srv.db.admin.query<{ state: string }>('SELECT state FROM erasure_cleanup_jobs WHERE workspace_id = $1', [ws]);
  expect(rows.every((row) => row.state === 'complete')).toBe(true);
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT, {}, { erasureCleanup: false });
  owner = await t.signUp(`protected-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);

  // Two real profiles, created the way the resolver creates them, so the erasure command has a
  // person to erase. Events are inserted through the event store below, which is the production
  // writer path and computes their subject hashes.
  const profileOf = async (userId: string, email: string) => {
    const profileId = newId('prf');
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, profileId]);
    for (const [type, value] of [
      ['user_id', userId],
      ['anonymous_id', `anon-${userId}-${stamp}`],
    ] as const)
      await t.srv.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
        ws,
        profileId,
        type,
        value,
      ]);
    await t.srv.db.admin.query(
      `INSERT INTO consent_records (workspace_id, profile_id, purpose, channel, status, basis, source)
       VALUES ($1, $2, 'marketing_email', 'email', 'granted', 'consent', 'api')`,
      [ws, profileId],
    );
    return { profileId, email };
  };
  erasedProfile = (await profileOf('erased-person', `erased-${stamp}@example.test`)).profileId;
  liveProfile = (await profileOf('live-person', `live-${stamp}@example.test`)).profileId;
  erasedAnonymous = `anon-erased-person-${stamp}`;
  liveAnonymous = `anon-live-person-${stamp}`;
  MEMBER = (
    await api.call('artifacts.create', {
      type: 'broadcast',
      name: 'Protected reads issue',
      content: {
        template: TEMPLATE,
        segment: 'seg_0000000000000000000000000000aaa1',
        description: 'Seeded for the protected-reads test',
      } as never,
    })
  ).artifactId;

  await t.srv.events.insert([
    event({ name: 'Purchase', profileId: erasedProfile, anonymousId: erasedAnonymous, userId: 'erased-person' }),
    event({ name: 'Purchase', profileId: liveProfile, anonymousId: liveAnonymous, userId: 'live-person' }),
  ]);
  await t.srv.events.insertMessageEvents([
    messageEvent({ profileId: erasedProfile, type: 'sent' }),
    messageEvent({ profileId: erasedProfile, type: 'delivered' }),
    messageEvent({ profileId: liveProfile, type: 'sent' }),
    messageEvent({ profileId: liveProfile, type: 'delivered' }),
  ]);
  await t.srv.events.insertJourneyEvents([
    journeyEvent({ profileId: erasedProfile, type: 'entered', participantId: 1 }),
    journeyEvent({ profileId: liveProfile, type: 'entered', participantId: 2 }),
  ]);

  await api.call('profiles.erase', { profileId: erasedProfile, reason: 'v0.17.0 protected reads' });
  await completeErasures();

  // Everything below is written after the erasure completed. The sweep will not run again, so only
  // read-time exclusion can keep it out of a reader.
  await t.srv.events.insert([
    event({
      name: 'Confirmed Signup',
      profileId: erasedProfile,
      anonymousId: erasedAnonymous,
      userId: 'erased-person',
      piiTraits: { email: `erased-${stamp}@example.test` },
    }),
    event({ name: 'Confirmed Signup', profileId: liveProfile, anonymousId: liveAnonymous, userId: 'live-person' }),
    event({
      name: 'Purchase',
      profileId: erasedProfile,
      anonymousId: erasedAnonymous,
      userId: 'erased-person',
      piiTraits: { email: `erased-${stamp}@example.test` },
    }),
    event({ name: 'Purchase', profileId: liveProfile, anonymousId: liveAnonymous, userId: 'live-person' }),
  ]);
  await t.srv.events.insertMessageEvents([
    messageEvent({ profileId: erasedProfile, type: 'sent' }),
    messageEvent({ profileId: erasedProfile, type: 'delivered' }),
    messageEvent({ profileId: liveProfile, type: 'sent' }),
    messageEvent({ profileId: liveProfile, type: 'delivered' }),
  ]);
  await t.srv.events.insertJourneyEvents([
    journeyEvent({ profileId: erasedProfile, type: 'entered', participantId: 1 }),
    journeyEvent({ profileId: liveProfile, type: 'entered', participantId: 2 }),
    // Two late step failures for the erased person: an alert rule that counted them would fire.
    journeyEvent({ profileId: erasedProfile, type: 'failed', node: 'send', seq: 2, participantId: 1 }),
    journeyEvent({ profileId: erasedProfile, type: 'failed', node: 'send', seq: 3, participantId: 1 }),
  ]);
  clearAnalyticsCache();
}, 240_000);

afterAll(() => t?.close());

describe('protected reads after an erasure (#1037 part 2)', () => {
  it('excludes the erased person from analytics.query totals and breakdowns', async () => {
    const api = t.api(owner, ws);
    const total = await api.call('analytics.query', {
      measures: ['conversions'],
      dimensions: [],
      from: FROM,
      to: TO,
      filters: { name: ['Purchase'] },
    });
    // Two conversion events, both the live person's. The erased person's post-erasure purchase and
    // address are the third the protected view has to drop.
    expect(total.rows).toEqual([[2]]);

    const byDay = await api.call('analytics.query', {
      measures: ['conversions'],
      dimensions: ['day'],
      from: FROM,
      to: TO,
      filters: { name: ['Purchase'] },
    });
    expect(byDay.rows).toEqual([['2026-11-10', 2]]);
  }, 60_000);

  it('excludes the erased person from a named report', async () => {
    const api = t.api(owner, ws);
    const report = await api.call('analytics.emailPerformance', { from: FROM, to: TO, by: 'day' });
    // The live person only: one sent and one delivered that day.
    expect(report.rows).toHaveLength(1);
    const sent = report.columns.findIndex((column) => column.name === 'email.sent');
    const delivered = report.columns.findIndex((column) => column.name === 'email.delivered');
    expect(report.rows[0]?.[sent]).toBe(1);
    expect(report.rows[0]?.[delivered]).toBe(1);
  }, 60_000);

  it('excludes the erased person from a segment event and engagement condition', async () => {
    const api = t.api(owner, ws);
    const eventSegment = await api.call('segments.preview', { condition: { event: 'Purchase', within: 'P30D' } });
    expect(eventSegment.count).toBe(1);
    expect(eventSegment.sample).toEqual([liveProfile]);
    const engagement = await api.call('segments.preview', { condition: { message: 'delivered', within: 'P30D' } });
    expect(engagement.count).toBe(1);
    expect(engagement.sample).toEqual([liveProfile]);
  }, 60_000);

  it('excludes the erased person from alert metrics', async () => {
    const api = t.api(owner, ws);
    const rule = await api.call('alerts.create', {
      name: 'Journey errors',
      kind: 'journey_errors',
      config: { window: 'P1D', threshold: 1, journeyId: JOURNEY },
      channels: [{ type: 'email', userIds: [owner.id] }],
    });
    // Two failed steps of the erased person are in the window; the rule must see none.
    await evaluateAlerts(
      {
        db: t.srv.db,
        events: t.srv.events,
        kp: t.srv.keyProvider,
        email: t.srv.email,
        directory: t.srv.directory,
        publicUrl: t.srv.publicUrl,
      },
      { now: new Date(AT) },
    );
    const { rows } = await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM alert_events WHERE workspace_id = $1 AND rule_id = $2',
      [ws, rule.rule.id],
    );
    expect(rows[0]?.n).toBe(0);
  }, 60_000);

  it('excludes the erased person from a campaign summary’s member breakdown', async () => {
    const api = t.api(owner, ws);
    // Five more people received the member's message, so the member row is above k and its counts
    // are visible; the erased person must not be the seventh.
    await t.srv.events.insertMessageEvents([
      ...['p1', 'p2', 'p3', 'p4', 'p5'].flatMap((p) => [
        messageEvent({ profileId: `prf_live_${p}`, type: 'sent' }),
        messageEvent({ profileId: `prf_live_${p}`, type: 'delivered' }),
      ]),
    ]);
    const campaignId = (
      await api.call('artifacts.create', {
        type: 'campaign',
        name: 'Protected reads campaign',
        content: {
          description: 'Campaign summary reads the same message log',
          goal: { kind: 'conversion', event: 'Purchase', attributionDays: 7 },
          members: [{ artifactId: MEMBER, role: 'primary' }],
        } as never,
      })
    ).artifactId;
    await api.call('artifacts.requestPublish', { artifactId: campaignId, note: 'v0.17.0 protected reads' });
    const summary = await api.call('analytics.campaignSummary', { campaignId, from: FROM, to: TO });
    if (summary.state !== 'measured') throw new Error(`campaign summary is ${summary.state}`);
    const member = summary.members[0]!;
    expect(member.suppressed).toBe(false);
    expect(member.sent).toBe(6);
    expect(member.delivered).toBe(6);
    expect(summary.headline.recipients).toBe(6);
  }, 120_000);

  it('excludes the erased person from a journey wait-until condition and the warehouse export', async () => {
    // waitUntil reuses the segment DSL for one person, evaluated against the protected reads.
    const condition = { message: 'delivered' as const, within: 'P30D' as const };
    const live = await t.srv.db.withWorkspace(ws, (tx) => matchesCondition(tx, ws, t.srv.events, [], liveProfile, condition));
    expect(live).toBe(true);
    const erased = await t.srv.db.withWorkspace(ws, (tx) => matchesCondition(tx, ws, t.srv.events, [], erasedProfile, condition));
    expect(erased).toBe(false);

    const exported: Record<string, unknown>[] = [];
    for await (const page of readDataset({ db: t.srv.db, events: t.srv.events }, ws, 'events', FROM, TO)) exported.push(...page);
    const names = exported.map((row) => row.name);
    // The erased person's late signup carried an address hash the sweep cannot reach: it must be
    // absent from the export, while the live person's is there.
    expect(names.filter((name) => name === 'Confirmed Signup')).toHaveLength(1);
    // The event dataset carries the person's ids, not their profile id.
    expect(exported.map((row) => row.user_id)).not.toContain('erased-person');
    expect(exported.map((row) => row.user_id)).toContain('live-person');
  }, 60_000);

  it('never serves a cached analytics result across an exclusion publication', async () => {
    const api = t.api(owner, ws);
    const query = {
      measures: ['conversions'],
      dimensions: [],
      from: FROM,
      to: TO,
      filters: { name: ['Purchase'] },
    };
    // Cached at the current generation: two live conversions.
    expect((await api.call('analytics.query', query)).rows).toEqual([[2]]);
    await t.srv.events.insert([event({ name: 'Purchase', profileId: liveProfile, anonymousId: liveAnonymous, userId: 'live-person' })]);
    // Still the cached answer while no publication happened — that is what makes the next step a
    // real assertion rather than a fresh read.
    expect((await api.call('analytics.query', query)).rows).toEqual([[2]]);
    // A publication moves the workspace's generation, exactly as the erasure worker does.
    await t.srv.db.admin.query('UPDATE erasure_generations SET generation = generation + 1 WHERE workspace_id = $1', [ws]);
    expect((await api.call('analytics.query', query)).rows).toEqual([[3]]);
  }, 60_000);

  it('excludes the erased person from both halves of a pending-outbox union', async () => {
    const since = new Date(FROM);
    // Distinct message ids, because the metric counts distinct messages.
    const pending: MessageEvent[] = [
      messageEvent({ messageId: 'bct_pending_erased', journeyId: 'bct_pending_erased', profileId: erasedProfile, type: 'sent' }),
      messageEvent({ messageId: 'bct_pending_live', journeyId: 'bct_pending_live', profileId: liveProfile, type: 'sent' }),
    ];
    const published = await t.srv.events.messageStats(ws, { since });
    const withPending = await t.srv.events.messageStats(ws, { since, pendingEvents: pending });
    // Published already counts 6 delivered people below; the union adds only the live person's
    // queued event, never the erased person's.
    expect(withPending.sent).toBe((published.sent ?? 0) + 1);
  }, 60_000);
});
