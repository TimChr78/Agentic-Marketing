import type { BusEvent, MessageEvent } from '@agentic-marketing/events';
import { contextFor, evaluate, publishedSegments } from '@agentic-marketing/segments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// #441: a segment can count the platform's own engagement — the opens and clicks recorded in the
// message log (`message_events`) — instead of hoping for a customer event. The same condition is
// compiled for whole-workspace refreshes and previews and evaluated for one person (journeys'
// wait-until), and a merge keeps what was recorded under an alias.

const today = () => Date.now();
const daysAgo = (days: number) => new Date(today() - days * 86_400_000).toISOString();

const BCT = `bct_${'a'.repeat(32)}`;
const SMSBCT = `bct_${'c'.repeat(32)}`;
const JRN = `jrn_${'b'.repeat(32)}`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
const ids: Record<string, string> = {};
/** The profile that was merged into Ada, whose messages must count for her. */
let eveId = '';
/** The id the merge folded away (whichever of Ada's two profiles survived). */
let aliasId = '';

const msg = (profileId: string, type: MessageEvent['type'], at: string, over: Partial<MessageEvent> = {}): MessageEvent => ({
  workspaceId: ws,
  messageId: `msg_${profileId}_${type}_${at}`,
  eventId: `evt_${profileId}_${type}_${at}_${over.channel ?? 'email'}`,
  type,
  at,
  profileId,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: '',
  templateVersion: 1,
  journeyId: BCT,
  reason: '',
  url: '',
  ...over,
});

beforeAll(async () => {
  t = await startTestServer('test_v0160_engaged', testPort(4468));
  owner = await t.signUp(`engaged-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
  const send = (batch: unknown[]) =>
    fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      body: JSON.stringify({ batch }),
    });
  await send([
    { type: 'identify', userId: 'ada', traits: { city: 'Aarhus', email: 'ada@example.com' } },
    { type: 'identify', userId: 'bo', traits: { city: 'Odense' } },
    { type: 'identify', userId: 'cy', traits: { city: 'Aarhus' } },
    { type: 'identify', userId: 'dee', traits: { city: 'Odense' } },
    { type: 'identify', anonymousId: 'anon-eve' },
  ]);
  const api = t.api(owner);
  for (const u of ['ada', 'bo', 'cy', 'dee'])
    ids[u] = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: u }),
        (r) => !!r.profileId,
      )
    ).profileId!;
  eveId = (
    await eventually(
      () => api.call('profiles.find', { type: 'anonymous_id', value: 'anon-eve' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  // One identify naming both ids merges the two profiles (identity resolution). Which one survives
  // is the older profile, and two created in the same millisecond are ordered by id, so read the
  // survivor instead of assuming: `ids.ada` stays the person, `aliasId` is the id the merge folded
  // away, whose messages must count for her.
  const adaBefore = ids.ada!;
  await send([{ type: 'identify', userId: 'ada', anonymousId: 'anon-eve' }]);
  const merged = await eventually(
    () => api.call('profiles.get', { profileId: adaBefore }),
    (r) => r.mergedFrom.length === 1,
    15_000,
  );
  expect(merged.mergedFrom).toHaveLength(1);
  aliasId = merged.mergedFrom[0]!;
  ids.ada = merged.id;
  expect([adaBefore, eveId]).toContain(ids.ada);
  expect([adaBefore, eveId]).toContain(aliasId);
  expect(aliasId).not.toBe(ids.ada);

  await t.srv.events.insertMessageEvents([
    // Ada: delivered, opened and clicked inside 30 days, plus an open outside it.
    msg(ids.ada!, 'delivered', daysAgo(5)),
    msg(ids.ada!, 'opened', daysAgo(4)),
    msg(ids.ada!, 'clicked', daysAgo(3), { url: 'https://example.com/signal' }),
    msg(ids.ada!, 'opened', daysAgo(45)),
    // Bo: opened and clicked from the welcome journey.
    msg(ids.bo!, 'opened', daysAgo(10), { journeyId: JRN }),
    msg(ids.bo!, 'clicked', daysAgo(10), { journeyId: JRN }),
    // Cy: SMS engagement, not e-mail.
    msg(ids.cy!, 'delivered', daysAgo(2), { channel: 'sms', purpose: 'marketing_sms', journeyId: SMSBCT }),
    msg(ids.cy!, 'clicked', daysAgo(2), {
      channel: 'sms',
      purpose: 'marketing_sms',
      journeyId: SMSBCT,
      url: 'https://example.com/sms',
    }),
    // Dee: only ever delivered.
    msg(ids.dee!, 'delivered', daysAgo(2)),
    // The profile that merged into Ada opened after the merge was recorded under its old id.
    msg(aliasId, 'opened', daysAgo(2)),
  ]);

  // Setup guard: every row is in the log under the profile id the send recorded (the store does not
  // resolve merges; the compiler below does). A missing id here would make the tests below lie.
  const stored = await t.srv.events.countMessageEvents(ws, { type: 'opened', sinceSeconds: 30 * 86_400 });
  expect(Object.fromEntries(stored.map((r) => [r.profileId, r.count]))).toEqual({
    [ids.ada!]: 1,
    [ids.bo!]: 1,
    [aliasId]: 1,
  });
}, 120_000);

afterAll(() => t?.close());

/** The preview's sample order is the database's, so compare as sets. */
const people = (sample: string[]) => [...sample].sort();

describe('message engagement conditions', () => {
  it('counts opens and clicks from the message log, inside the window', async () => {
    const api = t.api(owner);
    const opened = await api.call('segments.preview', { condition: { message: 'opened', within: 'P30D' } });
    // Ada's own open plus the one recorded under her merged-away alias, and Bo's.
    expect(opened.count).toBe(2);
    expect(people(opened.sample)).toEqual([ids.ada!, ids.bo!].sort());
    // Without the window Ada has two opens, so "at least twice" is only her.
    expect(
      people((await api.call('segments.preview', { condition: { message: 'opened', count: { gte: 2 }, within: 'P30D' } })).sample),
    ).toEqual([ids.ada!]);
    // A 45-day-old open is outside P30D.
    expect((await api.call('segments.preview', { condition: { message: 'opened', within: 'P45D' } })).count).toBe(2);
  });

  it('narrows by channel, purpose and the broadcast or journey that sent it', async () => {
    const api = t.api(owner);
    expect(
      people((await api.call('segments.preview', { condition: { message: 'clicked', channel: 'email', within: 'P7D' } })).sample),
    ).toEqual([ids.ada!]);
    expect(people((await api.call('segments.preview', { condition: { message: 'clicked', channel: 'sms' } })).sample)).toEqual([ids.cy!]);
    expect(people((await api.call('segments.preview', { condition: { message: 'clicked', purpose: 'marketing_sms' } })).sample)).toEqual([
      ids.cy!,
    ]);
    expect(people((await api.call('segments.preview', { condition: { message: 'opened', journey: JRN } })).sample)).toEqual([ids.bo!]);
    expect(people((await api.call('segments.preview', { condition: { message: 'clicked', broadcast: BCT } })).sample)).toEqual([ids.ada!]);
    expect(people((await api.call('segments.preview', { condition: { message: 'clicked', broadcast: SMSBCT } })).sample)).toEqual([
      ids.cy!,
    ]);
    expect((await api.call('segments.preview', { condition: { message: 'delivered', broadcast: BCT } })).count).toBe(2);
  });

  it('composes with not, all and any, and counts "never"', async () => {
    const api = t.api(owner);
    expect(people((await api.call('segments.preview', { condition: { not: { message: 'opened', within: 'P30D' } } })).sample)).toEqual(
      [ids.cy!, ids.dee!].sort(),
    );
    expect(
      people(
        (
          await api.call('segments.preview', {
            condition: { all: [{ message: 'opened', within: 'P30D' }, { not: { message: 'clicked', within: 'P7D' } }] },
          })
        ).sample,
      ),
    ).toEqual([ids.bo!]);
    expect(
      people(
        (
          await api.call('segments.preview', {
            condition: {
              any: [
                { message: 'clicked', channel: 'sms' },
                { trait: 'city', op: 'eq', value: 'Odense' },
              ],
            },
          })
        ).sample,
      ),
    ).toEqual([ids.bo!, ids.cy!, ids.dee!].sort());
    // "At most zero times" is everyone who never did it.
    expect(people((await api.call('segments.preview', { condition: { message: 'opened', count: { lte: 0 } } })).sample)).toEqual(
      [ids.cy!, ids.dee!].sort(),
    );
  });

  it('rejects a condition it cannot mean', async () => {
    const api = t.api(owner);
    const invalid = async (condition: unknown) => {
      const error = await rejects(api.call('segments.preview', { condition: condition as never }));
      expect(error.status).toBe(400);
      return `${error.message} ${JSON.stringify(error.details ?? {})}`;
    };
    expect(await invalid({ message: 'sent' })).toMatch(/message/);
    expect(await invalid({ message: 'opened', broadcast: BCT, journey: JRN })).toMatch(/broadcast or a journey/);
    expect(await invalid({ message: 'opened', broadcast: 'bct_notanid' })).toMatch(/bct_/);
    expect(await invalid({ message: 'opened', within: '30 days' })).toMatch(/ISO 8601/);
    expect(await invalid({ message: 'opened', purpose: 'no_such_purpose' })).toContain('purposes.list');
  });
});

describe('through the production refresh path', () => {
  it('fills a published segment, adds a new opener, and evaluates for one person', async () => {
    const api = t.api(owner);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Opened in the last 30 days',
      content: { description: 'Message engagement', condition: { message: 'opened', within: 'P30D' } },
    });
    await api.call('artifacts.requestPublish', { artifactId, note: 'First version' });
    // Publishing schedules a recompute, so the membership can already be there before the explicit
    // refresh below. Wait for it, then a manual refresh is an idempotent no-op.
    await eventually(
      () => api.call('segments.members', { artifactId }),
      (r) => people(r.members.map((m) => m.profileId)).join() === [ids.ada!, ids.bo!].sort().join(),
      15_000,
    );
    expect(people((await api.call('segments.members', { artifactId })).members.map((m) => m.profileId))).toEqual(
      [ids.ada!, ids.bo!].sort(),
    );
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ members: 2, entered: 0, exited: 0 });

    // Dee opens this week's issue: the next refresh moves her in and announces it.
    await t.srv.events.insertMessageEvents([msg(ids.dee!, 'opened', daysAgo(0))]);
    expect(await api.call('segments.refresh', { artifactId })).toMatchObject({ members: 3, entered: 1, exited: 0 });
    await eventually(
      () => api.call('profiles.events', { profileId: ids.dee! }),
      (r) => r.events.some((e) => e.name === 'Segment Entered' && e.properties.segment_id === artifactId),
    );

    // A journey's wait-until checks one person through the in-memory evaluator, including what
    // was recorded under a merged-away alias.
    const matched = await t.srv.db.withWorkspace(ws, async (tx) => {
      const all = await publishedSegments(tx);
      const ctx = contextFor(tx, ws, t.srv.events, all);
      const opened = await evaluate({ message: 'opened', within: 'P30D' }, { ...ctx, scope: [ids.ada!, ids.cy!, ids.dee!] });
      const sms = await evaluate({ message: 'clicked', channel: 'sms' }, { ...ctx, scope: [ids.cy!, ids.dee!] });
      return { opened: [...opened].sort(), sms: [...sms] };
    });
    expect(matched.opened).toEqual([ids.ada!, ids.dee!].sort());
    expect(matched.sms).toEqual([ids.cy!]);
  }, 120_000);

  it('leaves a message condition out of streaming, so a click alone does not move it', async () => {
    // `relevant` decides whether a customer event re-evaluates a segment; message events are not
    // customer events, so the scheduler's refresh (and segments.refresh) is what moves this one.
    const { relevant } = await import('@agentic-marketing/segments');
    const event: BusEvent = {
      workspaceId: ws,
      sourceId: 'email',
      messageId: 'm1',
      type: 'track',
      name: 'Email Link Clicked',
      anonymousId: 'a',
      userId: 'ada',
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      properties: {},
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
    };
    expect(relevant({ message: 'clicked', within: 'P7D' }, event)).toBe(false);
    expect(relevant({ all: [{ event: 'Email Link Clicked' }, { message: 'clicked' }] }, event)).toBe(true);
  });
});
