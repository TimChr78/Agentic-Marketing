import { canaryAssignment } from '@agentic-marketing/audience';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Issue #254: a staged send goes to a deterministic canary share first, waits, checks the canary's
// base counts (bounces, complaints, unsubscribes) against thresholds, then sends the rest — or
// stops and waits for a person. Time is driven forward in the database; nothing waits for a timer.

const PORT = testPort(3406);
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

const createPublished = async (type: 'email_template' | 'segment' | 'broadcast', name: string, content: object) => {
  const a = await api().call('artifacts.create', { type, name, content });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'staged sends test' });
  return a.artifactId;
};

const broadcast = async (content: object) => createPublished('broadcast', `staged ${Date.now()}-${Math.random()}`, content);

const status = (artifactId: string) => api().call('broadcasts.status', { artifactId });

interface MessageRow {
  id: string;
  profile_id: string;
  variant: string | null;
  status: string;
  not_before: Date | null;
  reason: string | null;
}

const messagesOf = async (artifactId: string): Promise<MessageRow[]> =>
  (
    await t.srv.db.admin.query<MessageRow>(
      'SELECT id, profile_id, variant, status, not_before, reason FROM messages WHERE workspace_id = $1 AND journey_id = $2 ORDER BY profile_id',
      [ws, artifactId],
    )
  ).rows;

const canaryMessages = async (artifactId: string, canaryPercent: number) =>
  (await messagesOf(artifactId)).filter((m) => canaryAssignment(m.profile_id, artifactId, canaryPercent));

/** Let the canary's sent events reach ClickHouse before the check runs, and wait until none is in flight. */
const waitForCanarySent = async (artifactId: string, canaryPercent: number, atLeast: number) =>
  eventually(
    async () => {
      // The check counts sends from the message events in ClickHouse, which can lag the messages table.
      const canary = await canaryMessages(artifactId, canaryPercent);
      if (canary.length < atLeast) return 0;
      // A deferred canary message that is still queued makes the check wait (it is not judged on a
      // partial canary), so the canary must really be out before a forced check runs.
      if (canary.some((m) => m.status === 'queued' || m.status === 'sending')) return 0;
      const stats = await t.srv.events.messageStats(ws, {
        since: new Date(Date.now() - 3_600_000),
        journeyId: artifactId,
        messageIds: canary.map((m) => m.id),
      });
      return stats.sent ?? 0;
    },
    (n) => n >= atLeast,
    30_000,
  );

/** Move the check and the run's wake time into the past, as a clock would after the wait. */
const checkNow = async (artifactId: string) => {
  await t.srv.db.admin.query(
    `UPDATE broadcast_stages SET check_at = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, artifactId],
  );
  await t.srv.db.admin.query(
    `UPDATE broadcast_runs SET lease_until = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, artifactId],
  );
};

const event = (m: MessageRow, type: 'unsubscribed' | 'bounced' | 'complained', broadcastId: string, n: number) => ({
  workspaceId: ws,
  messageId: m.id,
  eventId: `${type}:${m.id}:${n}`,
  type,
  at: new Date().toISOString(),
  profileId: m.profile_id,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: template,
  templateVersion: 1,
  journeyId: broadcastId,
  reason: '',
  url: '',
});

beforeAll(async () => {
  t = await startTestServer('test_staged_sends', PORT);
  owner = await t.signUp(`owner-staged-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const client = api();
  await client.call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await client.call('sources.create', { name: 'Backend', kind: 'server' })).key;

  const people = Array.from({ length: PEOPLE }, (_, i) => ({
    type: 'identify',
    userId: `u${i}`,
    // Two far-apart zones so a send window defers the canary at different openings (#285).
    traits: { email: `p${i}@example.com`, firstName: `P${i}`, timezone: i % 2 ? 'UTC' : 'Pacific/Auckland' },
  }));
  expect((await ingest(people)).status).toBe(200);

  const ids = await eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ id: string; value: string }>(
          "SELECT i.profile_id AS id, i.value FROM identifiers i WHERE i.workspace_id = $1 AND i.type = 'user_id'",
          [ws],
        )
      ).rows,
    (rows) => rows.length === PEOPLE,
    20_000,
  );
  for (const row of ids) await client.call('consent.record', { profileId: row.id, purpose: 'marketing_email', status: 'granted' });

  template = await createPublished('email_template', 'staged newsletter', {
    purpose: 'marketing_email',
    subject: 'The staged subject',
    mjml: mjml('Hello {{ profile.firstName | default: "reader" }}'),
  });
  segment = await createPublished('segment', 'staged subscribers', { condition: { consent: 'marketing_email' } });
  await client.call('segments.refresh', { artifactId: segment });
  await eventually(
    async () => (await client.call('segments.members', { artifactId: segment })).members.length,
    (n) => n === PEOPLE,
    20_000,
  );
}, 120_000);

afterAll(() => t?.close());

describe('staged send', () => {
  it('sends the canary share first and nothing else until the wait passes', async () => {
    const id = await broadcast({
      template,
      segment,
      stagedSend: { canaryPercent: 20, wait: 'PT2H', minCanary: 5 },
    });
    const waiting = await eventually(
      () => status(id),
      (s) => s.stage?.stage === 'canary_waiting' && s.stage.canary.queued >= 1,
      20_000,
    );
    expect(waiting.run.status).toBe('running');
    expect(waiting.stage).not.toBeNull();
    expect(waiting.stage?.canaryPercent).toBe(20);

    const sent = await messagesOf(id);
    // ~20% of 120 people, spread by a hash: the binomial spread is several people wide.
    expect(sent.length).toBeGreaterThanOrEqual(10);
    expect(sent.length).toBeLessThanOrEqual(40);
    expect(sent.every((m) => canaryAssignment(m.profile_id, id, 20))).toBe(true);

    // No clock has passed: the run stays parked on the check and sends nobody else.
    await new Promise((r) => setTimeout(r, 1_000));
    const still = await status(id);
    expect(still.stage?.stage).toBe('canary_waiting');
    expect((await messagesOf(id)).length).toBe(sent.length);

    // A later stage in the same suite drives it forward; this one only proves the pause.
  }, 60_000);

  it('sends the rest when the canary check is clean', async () => {
    const id = await broadcast({
      template,
      segment,
      stagedSend: { canaryPercent: 20, wait: 'PT2H', minCanary: 5 },
    });
    await eventually(
      () => status(id),
      (s) => s.stage?.stage === 'canary_waiting' && s.stage.canary.queued >= 1,
      20_000,
    );
    const canaryCount = (await canaryMessages(id, 20)).length;
    await waitForCanarySent(id, 20, 5);
    await checkNow(id);

    const done = await eventually(
      () => status(id),
      (s) => s.run.status === 'done' && s.stage?.stage === 'done',
      30_000,
    );
    expect(done.stage?.checkSkipped).toBe(false);
    expect(done.stage?.bounceRate).toBe(0);
    expect(done.stage?.unsubscribeRate).toBe(0);

    const all = await messagesOf(id);
    expect(all.length).toBe(PEOPLE);
    expect(all.filter((m) => canaryAssignment(m.profile_id, id, 20)).length).toBe(canaryCount);
    const perProfile = new Map<string, number>();
    for (const m of all) perProfile.set(m.profile_id, (perProfile.get(m.profile_id) ?? 0) + 1);
    expect([...perProfile.values()].every((n) => n === 1)).toBe(true);
    expect(outbox.filter((m) => m.subject === 'The staged subject').length).toBeGreaterThanOrEqual(canaryCount);
  }, 60_000);

  it('stops on canary unsubscribes above the threshold and sends no one else', async () => {
    const id = await broadcast({
      template,
      segment,
      stagedSend: { canaryPercent: 20, wait: 'PT2H', minCanary: 5, maxUnsubscribeRate: 0.02 },
    });
    await eventually(
      () => status(id),
      (s) => s.stage?.stage === 'canary_waiting' && s.stage.canary.queued >= 1,
      20_000,
    );
    const canary = await canaryMessages(id, 20);
    await waitForCanarySent(id, 20, 5);
    // Two unsubscribes from ~24 canary sends is ~8%, over the 2% limit.
    await t.srv.events.insertMessageEvents(canary.slice(0, 2).map((m, i) => event(m, 'unsubscribed', id, i)));
    await checkNow(id);

    const stopped = await eventually(
      () => status(id),
      (s) => s.run.status === 'stopped' && s.stage?.stage === 'stopped',
      30_000,
    );
    expect(stopped.stage?.stopReason).toContain('unsubscribe rate');
    expect(stopped.stage?.unsubscribed).toBeGreaterThanOrEqual(2);
    expect(stopped.stage?.unsubscribeRate).toBeGreaterThan(2);
    expect(stopped.stage?.checkedAt).not.toBeNull();

    const afterStop = await messagesOf(id);
    expect(afterStop.length).toBe(canary.length);
    // The run is terminal for the scheduler: nothing follows the stop.
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await messagesOf(id)).length).toBe(canary.length);
    expect((await status(id)).stage?.stage).toBe('stopped');

    // A person sends the rest after looking at the rates.
    expect(await api().call('broadcasts.continue', { artifactId: id })).toMatchObject({ status: 'sending_rest' });
    const resumed = await eventually(
      () => status(id),
      (s) => s.run.status === 'done' && s.stage?.stage === 'done',
      30_000,
    );
    expect(resumed.stage?.resumedAt).not.toBeNull();
    expect(resumed.stage?.stopReason).toContain('unsubscribe rate');
    const all = await messagesOf(id);
    expect(all.length).toBe(PEOPLE);
    expect(all.every((m) => m.profile_id)).toBe(true);
  }, 60_000);

  it('waits for a canary deferred by a send window, then checks the full canary', async () => {
    // A window that is closed now in both zones, opening an hour later in UTC and about half a
    // day later in Auckland: the canary spans different openings, so the check must use the
    // latest one and still wait for every canary message to have gone out (#285).
    const now = new Date();
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const start = clock(now.getUTCHours() * 60 + now.getUTCMinutes() + 60);
    const end = clock(now.getUTCHours() * 60 + now.getUTCMinutes() + 180);
    const id = await broadcast({
      template,
      segment,
      sendAt: now.toISOString(),
      sendWindow: { start, end, maxDelay: 'P1D' },
      stagedSend: { canaryPercent: 20, wait: 'PT2H', minCanary: 5 },
    });
    await eventually(
      () => status(id),
      (s) => s.stage?.stage === 'canary_waiting' && s.stage.canary.queued >= 1,
      20_000,
    );
    const canary = await canaryMessages(id, 20);
    expect(canary.length).toBeGreaterThanOrEqual(5);
    expect(canary.every((m) => m.status === 'queued' && m.not_before)).toBe(true);
    const stage = (await status(id)).stage;
    const starts = canary.map((m) => new Date(m.not_before!).getTime());
    const earliestStart = Math.min(...starts);
    const latestStart = Math.max(...starts);
    // The zones defer to different openings, and the check is after the latest one, not the first.
    expect(latestStart).toBeGreaterThan(earliestStart);
    expect(new Date(stage?.checkAt ?? 0).getTime()).toBeGreaterThanOrEqual(latestStart + 2 * 3_600_000);

    // The wait is over, but the canary has not gone out: the check is postponed, not run.
    await checkNow(id);
    const parkedAt = await eventually(
      async () => {
        const s = await status(id);
        return s.stage?.stage === 'canary_waiting' && s.stage.checkAt && new Date(s.stage.checkAt).getTime() > Date.now()
          ? new Date(s.stage.checkAt).getTime()
          : 0;
      },
      (at) => at > 0,
      20_000,
    );
    expect(parkedAt).toBeGreaterThan(latestStart);
    expect((await status(id)).stage?.checkedAt).toBeNull();
    expect((await messagesOf(id)).length).toBe(canary.length);
    expect((await messagesOf(id)).every((m) => m.status === 'queued')).toBe(true);

    // The windows open: every canary message goes out, then the check sees the whole canary.
    await t.srv.db.admin.query(
      `UPDATE messages SET not_before = now() - interval '1 minute' WHERE workspace_id = $1 AND journey_id = $2 AND status = 'queued'`,
      [ws, id],
    );
    await waitForCanarySent(id, 20, canary.length);
    await checkNow(id);
    const done = await eventually(
      () => status(id),
      (s) => s.run.status === 'done' && s.stage?.stage === 'done',
      30_000,
    );
    expect(done.stage?.checkSkipped).toBe(false);
    expect(done.stage?.sent).toBe(canary.length);
    expect((await messagesOf(id)).length).toBe(PEOPLE);
  }, 90_000);

  it('proceeds without a check when the canary is smaller than minCanary', async () => {
    const id = await broadcast({
      template,
      segment,
      stagedSend: { canaryPercent: 5, wait: 'PT2H', minCanary: 50 },
    });
    await eventually(
      () => status(id),
      (s) => s.stage?.stage === 'canary_waiting' && s.stage.canary.queued >= 1,
      20_000,
    );
    await checkNow(id);
    const done = await eventually(
      () => status(id),
      (s) => s.run.status === 'done' && s.stage?.stage === 'done',
      30_000,
    );
    expect(done.stage?.checkSkipped).toBe(true);
    expect(done.stage?.sent).toBeLessThan(50);
    expect((await messagesOf(id)).length).toBe(PEOPLE);
  }, 60_000);

  it('rejects a staged send combined with a subject test', async () => {
    await expect(
      api().call('artifacts.create', {
        type: 'broadcast',
        name: `staged conflict ${Date.now()}`,
        content: {
          template,
          segment,
          subjectTest: { subjects: ['One', 'Two'], samplePercent: 20, metric: 'click', decideAfter: 'PT4H' },
          stagedSend: { canaryPercent: 10, wait: 'PT2H' },
        },
      }),
    ).rejects.toThrow(/staged send cannot be combined/i);
  }, 30_000);
});
