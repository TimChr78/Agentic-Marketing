import { subjectAssignment } from '@agentic-marketing/audience';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Phase 15 (#88, #70): newsletter subject A/B tests and recipient-local send windows on
// broadcasts. Times and decisions are moved forward in the database; nothing waits for a timer.

const PORT = testPort(3460);
const PEOPLE = 120;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let template = '';
let segment = '';

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const ingest = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const api = () => t.api(owner, ws);
const mailTo = (to: string) => outbox.filter((m) => m.to === to);

const createPublished = async (type: 'email_template' | 'segment' | 'broadcast', name: string, content: object) => {
  const a = await api().call('artifacts.create', { type, name, content });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'v028 test' });
  return a.artifactId;
};

const broadcast = async (content: object) => createPublished('broadcast', `v028 ${Date.now()}-${Math.random()}`, content);

const status = (artifactId: string) => api().call('broadcasts.status', { artifactId });

const messagesOf = async (artifactId: string) =>
  (
    await t.srv.db.admin.query<{
      id: string;
      profile_id: string;
      variant: string | null;
      status: string;
      not_before: Date | null;
      reason: string | null;
    }>(
      'SELECT id, profile_id, variant, status, not_before, reason FROM messages WHERE workspace_id = $1 AND journey_id = $2 ORDER BY profile_id',
      [ws, artifactId],
    )
  ).rows;

const click = (message: { id: string; profile_id: string }, broadcastId: string, n: number) => ({
  workspaceId: ws,
  messageId: message.id,
  eventId: `click:${message.id}:${n}`,
  type: 'clicked' as const,
  at: new Date().toISOString(),
  profileId: message.profile_id,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: template,
  templateVersion: 1,
  journeyId: broadcastId,
  reason: '',
  url: 'https://example.com/',
});

/** Move the decision and the run's wake time into the past, as a clock would after decideAfter. */
const decideNow = async (artifactId: string) => {
  await t.srv.db.admin.query(
    `UPDATE broadcast_tests SET decide_at = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, artifactId],
  );
  await t.srv.db.admin.query(
    `UPDATE broadcast_runs SET lease_until = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, artifactId],
  );
};

const localClock = (at: Date, zone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
    at,
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    minutes: get('hour') * 60 + get('minute'),
    text: `${String(get('hour')).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}`,
  };
};

const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

beforeAll(async () => {
  t = await startTestServer('test_v028_abtest', PORT);
  owner = await t.signUp(`owner-abtest-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const client = api();
  await client.call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await client.call('sources.create', { name: 'Backend', kind: 'server' })).key;

  const people = [
    ...Array.from({ length: PEOPLE }, (_, i) => ({
      type: 'identify',
      userId: `u${i}`,
      traits: { email: `p${i}@example.com`, firstName: `P${i}` },
    })),
    { type: 'identify', userId: 'uhold', traits: { email: 'hold@example.com', scenario: 'hold', timezone: 'Pacific/Auckland' } },
    { type: 'identify', userId: 'uskip', traits: { email: 'skip@example.com', scenario: 'skip', timezone: 'America/New_York' } },
  ];
  expect((await ingest(people)).status).toBe(200);

  const ids = await eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ id: string; value: string }>(
          "SELECT i.profile_id AS id, i.value FROM identifiers i WHERE i.workspace_id = $1 AND i.type = 'user_id'",
          [ws],
        )
      ).rows,
    (rows) => rows.length === PEOPLE + 2,
    20_000,
  );
  for (const row of ids) await client.call('consent.record', { profileId: row.id, purpose: 'marketing_email', status: 'granted' });

  template = await createPublished('email_template', 'v028 newsletter', {
    purpose: 'marketing_email',
    subject: 'The default subject',
    mjml: mjml('Hello {{ profile.firstName | default: "reader" }}'),
  });
  segment = await createPublished('segment', 'v028 subscribers', { condition: { consent: 'marketing_email' } });
  await client.call('segments.refresh', { artifactId: segment });
  await eventually(
    async () => (await client.call('segments.members', { artifactId: segment })).members.length,
    (n) => n === PEOPLE + 2,
    20_000,
  );
}, 120_000);

afterAll(() => t?.close());

describe('subject assignment', () => {
  it('is deterministic, samples the requested share, and splits the sample evenly', () => {
    const first = subjectAssignment('prf_0123456789abcdef0123456789abcdef', 'bct_0123456789abcdef0123456789abcdef', 20, 2);
    for (let i = 0; i < 10; i++)
      expect(subjectAssignment('prf_0123456789abcdef0123456789abcdef', 'bct_0123456789abcdef0123456789abcdef', 20, 2)).toBe(first);

    let sampled = 0;
    const split = { A: 0, B: 0 };
    for (let i = 0; i < 10_000; i++) {
      const variant = subjectAssignment(`prf_${i.toString().padStart(32, '0')}`, 'bct_0123456789abcdef0123456789abcdef', 20, 2);
      if (!variant) continue;
      sampled++;
      split[variant as 'A' | 'B']++;
    }
    expect(sampled).toBeGreaterThan(1_700);
    expect(sampled).toBeLessThan(2_300);
    expect(Math.abs(split.A - split.B)).toBeLessThan(200);
  }, 60_000);
});

describe('subject A/B test', () => {
  let winnerId = '';
  let sampleMessages: {
    id: string;
    profile_id: string;
    variant: string | null;
    status: string;
    not_before: Date | null;
    reason: string | null;
  }[] = [];
  let withdrawnEmail = '';

  it('sends the sample, records variants and the split, then gives the rest the winner', async () => {
    winnerId = await broadcast({
      template,
      segment,
      subjectTest: { subjects: ['Control subject', 'Challenger subject'], samplePercent: 50, decideAfter: 'PT4H' },
    });
    const deciding = await eventually(
      () => status(winnerId),
      (s) => s.test?.state === 'deciding' && s.test.variants.reduce((n, v) => n + v.sent, 0) >= 1,
      20_000,
    );
    expect(deciding.test).not.toBeNull();
    expect(deciding.test?.decideAt).not.toBeNull();

    sampleMessages = (await messagesOf(winnerId)).filter((m) => m.variant !== null);
    expect(sampleMessages.length).toBeGreaterThanOrEqual(45);
    expect(sampleMessages.length).toBeLessThanOrEqual(75);
    const byVariant = new Map<string, number>();
    for (const m of sampleMessages) byVariant.set(m.variant!, (byVariant.get(m.variant!) ?? 0) + 1);
    expect(byVariant.get('A')).toBeGreaterThanOrEqual(20);
    expect(byVariant.get('B')).toBeGreaterThanOrEqual(20);
    // The split is a hash of random profile ids, so it is binomial: with ~60 sends the difference
    // has a standard deviation near 8. Each arm within 30–70% is about three standard deviations.
    for (const v of ['A', 'B']) {
      const share = (byVariant.get(v) ?? 0) / sampleMessages.length;
      expect(share).toBeGreaterThanOrEqual(0.3);
      expect(share).toBeLessThanOrEqual(0.7);
    }
    await eventually(
      () => status(winnerId),
      (s) => (s.test?.variants.reduce((n, v) => n + v.sent, 0) ?? 0) === sampleMessages.length,
      20_000,
    );

    // One non-sample reader withdraws before the rest goes out; the gateway must refuse them.
    const sampleIds = new Set(sampleMessages.map((m) => m.profile_id));
    const userIds = await t.srv.db.admin.query<{ profile_id: string; value: string }>(
      "SELECT profile_id, value FROM identifiers WHERE workspace_id = $1 AND type = 'user_id'",
      [ws],
    );
    const outside = userIds.rows.find((r) => /^u\d+$/.test(r.value) && !sampleIds.has(r.profile_id));
    expect(outside).toBeTruthy();
    withdrawnEmail = `p${outside!.value.slice(1)}@example.com`;
    await api().call('consent.record', { profileId: outside!.profile_id, purpose: 'marketing_email', status: 'withdrawn' });

    // Clicks for variant B decide it: every sample message of B gets one.
    const b = sampleMessages.filter((m) => m.variant === 'B');
    await t.srv.events.insertMessageEvents(b.map((m, i) => click(m, winnerId, i)));
    await decideNow(winnerId);

    const done = await eventually(
      () => status(winnerId),
      (s) => s.test?.state === 'winner_sent' && s.run.status === 'done' && (s.messages.sent ?? 0) >= PEOPLE,
      20_000,
    );
    expect(done.test?.winner).toBe('B');
    expect(done.test?.reason).toContain('won on click');
    expect(done.run.recipients).toBeGreaterThanOrEqual(PEOPLE);
    expect(done.run.queued).toBe(PEOPLE + 1);
    // The status lists every variant with its counts and rates.
    expect(done.test?.variants.map((v) => v.variant)).toEqual(['A', 'B']);
    expect(done.test?.variants[1].clickRate).toBeGreaterThan(0);

    // The winner went to the rest: every later message is variant B, every person has at most one.
    const all = await messagesOf(winnerId);
    const sampleIdSet = new Set(sampleMessages.map((m) => m.id));
    const rest = all.filter((m) => !sampleIdSet.has(m.id));
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((m) => m.variant === 'B')).toBe(true);
    const perProfile = new Map<string, number>();
    for (const m of all) perProfile.set(m.profile_id, (perProfile.get(m.profile_id) ?? 0) + 1);
    expect([...perProfile.values()].every((n) => n === 1)).toBe(true);

    const bMails = outbox.filter((m) => m.subject === 'Challenger subject');
    const aMails = outbox.filter((m) => m.subject === 'Control subject');
    // A message reaches the outbox a moment before its status is marked sent: wait for the two to agree.
    const sentIds = new Set(rest.map((m) => m.id));
    const restSent = await eventually(
      async () => (await messagesOf(winnerId)).filter((m) => sentIds.has(m.id) && (m.status === 'sent' || m.status === 'delivered')).length,
      (n) => n === bMails.length - b.length,
      15_000,
    );
    expect(bMails.length).toBe(b.length + restSent);
    expect(aMails.length).toBe(sampleMessages.length - b.length);
    expect(mailTo(withdrawnEmail)).toHaveLength(0);

    // messages.stats can narrow to a variant.
    const stats = await eventually(
      () => api().call('messages.stats', { days: 1, templateId: template, variant: 'B' }),
      (s) => (s.counts.clicked ?? 0) >= b.length,
    );
    expect(stats.counts.clicked).toBe(b.length);
  }, 60_000);

  it('picks A on a tie and records that there was no clear winner', async () => {
    const id = await broadcast({
      template,
      segment,
      subjectTest: { subjects: ['Tie A', 'Tie B'], samplePercent: 50, decideAfter: 'PT4H' },
    });
    await eventually(
      () => status(id),
      (s) => s.test?.state === 'deciding' && s.test.variants.reduce((n, v) => n + v.sent, 0) >= 1,
      20_000,
    );
    const sample = (await messagesOf(id)).filter((m) => m.variant);
    await eventually(
      () => status(id),
      (s) => (s.test?.variants.reduce((n, v) => n + v.sent, 0) ?? 0) === sample.length,
      20_000,
    );
    const a = sample.filter((m) => m.variant === 'A').slice(0, 5);
    const b = sample.filter((m) => m.variant === 'B').slice(0, 5);
    await t.srv.events.insertMessageEvents([...a.map((m, i) => click(m, id, i)), ...b.map((m, i) => click(m, id, 100 + i))]);
    await decideNow(id);

    const done = await eventually(
      () => status(id),
      (s) => s.test?.state === 'winner_sent' && s.run.status === 'done',
      20_000,
    );
    expect(done.test?.winner).toBe('A');
    // The split is random: a variant can end up under the 20-send minimum, which also picks A,
    // with its own reason. Assert the reason that matches the actual split.
    const fewest = Math.min(...(done.test?.variants.map((v) => v.sent) ?? [0]));
    expect(done.test?.reason).toContain(fewest >= 20 ? 'tie' : 'fewer than 20 sends');
  }, 60_000);

  it('picks A when a variant has fewer than 20 sends, even with more clicks', async () => {
    const id = await broadcast({
      template,
      segment,
      subjectTest: { subjects: ['Small A', 'Small B'], samplePercent: 20, decideAfter: 'PT4H' },
    });
    await eventually(
      () => status(id),
      (s) => s.test?.state === 'deciding' && s.test.variants.reduce((n, v) => n + v.sent, 0) >= 1,
      45_000,
    );
    const sample = (await messagesOf(id)).filter((m) => m.variant);
    expect(sample.length).toBeLessThan(40);
    await eventually(
      () => status(id),
      (s) => (s.test?.variants.reduce((n, v) => n + v.sent, 0) ?? 0) === sample.length,
      45_000,
    );
    const b = sample.filter((m) => m.variant === 'B');
    await t.srv.events.insertMessageEvents(b.map((m, i) => click(m, id, i)));
    await decideNow(id);

    const done = await eventually(
      () => status(id),
      (s) => s.test?.state === 'winner_sent' && s.run.status === 'done',
      45_000,
    );
    expect(done.test?.winner).toBe('A');
    expect(done.test?.reason).toContain('fewer than 20 sends');
  }, 150_000);
});

describe('recipient-local send window', () => {
  it('holds a reader in another time zone until their window opens', async () => {
    const hold = await createPublished('segment', 'v028 hold', {
      condition: { all: [{ consent: 'marketing_email' }, { trait: 'scenario', op: 'eq', value: 'hold' }] },
    });
    await api().call('segments.refresh', { artifactId: hold });
    await eventually(
      async () => (await api().call('segments.members', { artifactId: hold })).members.length,
      (n) => n === 1,
      10_000,
    );

    const zone = 'Pacific/Auckland';
    const now = localClock(new Date(), zone);
    const start = clock(now.minutes + 120);
    const end = clock(now.minutes + 180);
    const id = await broadcast({
      template,
      segment: hold,
      sendAt: new Date().toISOString(),
      sendWindow: { start, end, maxDelay: 'P1D' },
    });
    const done = await eventually(
      () => status(id),
      (s) => s.run.status === 'done',
      20_000,
    );
    expect(done.run).toMatchObject({ recipients: 1, queued: 1, skipped: 0, windowSkipped: 0 });

    const [m] = await messagesOf(id);
    expect(m.status).toBe('queued');
    expect(m.not_before).not.toBeNull();
    expect(localClock(new Date(m.not_before!), zone).text).toBe(start);
    expect(outbox.filter((x) => x.to === 'hold@example.com' && x.subject === 'The default subject')).toHaveLength(0);
  }, 60_000);

  it('skips a reader when the next window is beyond maxDelay', async () => {
    const skip = await createPublished('segment', 'v028 skip', {
      condition: { all: [{ consent: 'marketing_email' }, { trait: 'scenario', op: 'eq', value: 'skip' }] },
    });
    await api().call('segments.refresh', { artifactId: skip });
    await eventually(
      async () => (await api().call('segments.members', { artifactId: skip })).members.length,
      (n) => n === 1,
      10_000,
    );

    const zone = 'America/New_York';
    const now = localClock(new Date(), zone);
    const start = clock(now.minutes + 180);
    const end = clock(now.minutes + 240);
    const id = await broadcast({
      template,
      segment: skip,
      sendAt: new Date().toISOString(),
      sendWindow: { start, end, maxDelay: 'PT1H' },
    });
    const done = await eventually(
      () => status(id),
      (s) => s.run.status === 'done',
      20_000,
    );
    expect(done.run).toMatchObject({ recipients: 1, queued: 0, skipped: 1, windowSkipped: 1 });

    const [m] = await messagesOf(id);
    expect(m.status).toBe('suppressed');
    expect(m.reason).toContain('outside_send_window');
    expect(outbox.filter((x) => x.to === 'skip@example.com' && x.subject === 'The default subject')).toHaveLength(0);
  }, 60_000);
});
