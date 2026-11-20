import { canaryAssignment, dispatchOutboxOnce } from '@agentic-marketing/audience';
import { enqueueMessageEvents } from '@agentic-marketing/email';
import type { MessageEvent } from '@agentic-marketing/events';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seededRandom } from '../../../test-support/index';
import { eventually, startTestServer, testPort, type User } from './harness';

// #1038: one provider webhook batch can carry events for several broadcasts. `enqueueMessageEvents`
// must name each event's broadcast in the outbox row, because the publication barrier that defers a
// staged-send canary check and a subject-test winner filters on `subject_ref`. A mixed batch left
// without one is invisible to the barrier, so a decision can be taken while its clicks or
// unsubscribes are still queued for ClickHouse.

const PORT = testPort(3541);
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
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: '#1038 mixed batch test' });
  return a.artifactId;
};

const random = seededRandom();
const broadcast = async (content: object) => createPublished('broadcast', `mixed ${Date.now()}-${random()}`, content);

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

/** Publish what is queued and wait for the outbox to be empty, so only the mixed batch can defer. */
const flushOutbox = async () => {
  await t.srv.db.admin.query(`UPDATE outbox SET next_attempt_at = now() WHERE workspace_id = $1 AND state = 'pending'`, [ws]);
  await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, bus: t.srv.bus }, { batch: 5000 });
  await eventually(
    async () =>
      Number(
        (
          await t.srv.db.admin.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM outbox WHERE workspace_id = $1 AND state IN ('pending', 'delivering')`,
            [ws],
          )
        ).rows[0]?.n ?? 0,
      ),
    (n) => n === 0,
    15_000,
  );
};

/**
 * Holds every row this workspace enqueues from the moment it is written, the state a ClickHouse or
 * dispatcher outage leaves behind, without sleeping. Unlike moving `next_attempt_at` afterwards,
 * the row is never claimable, so the deferral cannot be raced.
 */
async function holdPublication() {
  await t.srv.db.admin.query(`CREATE OR REPLACE FUNCTION am_test_hold_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.workspace_id = '${ws}'::uuid THEN NEW.next_attempt_at := now() + interval '1 hour'; END IF;
      RETURN NEW;
    END $$`);
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox');
  await t.srv.db.admin.query(
    'CREATE TRIGGER am_test_hold_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION am_test_hold_outbox()',
  );
}

async function releasePublication() {
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox');
  await t.srv.db.admin.query('DROP FUNCTION IF EXISTS am_test_hold_outbox()');
  await t.srv.db.admin.query(`UPDATE outbox SET next_attempt_at = now() WHERE workspace_id = $1 AND state = 'pending'`, [ws]);
}

/** Move the canary check and the subject-test decision, and their run leases, into the past. */
const decideNow = async (artifactId: string, kind: 'canary' | 'subject') => {
  if (kind === 'canary')
    await t.srv.db.admin.query(
      `UPDATE broadcast_stages SET check_at = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
      [ws, artifactId],
    );
  else
    await t.srv.db.admin.query(
      `UPDATE broadcast_tests SET decide_at = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
      [ws, artifactId],
    );
  await t.srv.db.admin.query(
    `UPDATE broadcast_runs SET lease_until = now() - interval '1 minute' WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, artifactId],
  );
};

const runOf = async (artifactId: string) =>
  (
    await t.srv.db.admin.query<{ lease_until: Date | null; defer_count: number; status: string }>(
      'SELECT lease_until, defer_count, status FROM broadcast_runs WHERE workspace_id = $1 AND broadcast_id = $2',
      [ws, artifactId],
    )
  ).rows[0];

/** A row that names no broadcast: the bug's shape, and why the barrier cannot see it. */
const unsubjectedRows = async () =>
  Number(
    (
      await t.srv.db.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox
         WHERE workspace_id = $1 AND kind = 'message_event' AND subject_ref IS NULL AND state IN ('pending', 'delivering')`,
        [ws],
      )
    ).rows[0]?.n ?? 0,
  );

beforeAll(async () => {
  t = await startTestServer('test_outbox_mixed_subjects', PORT);
  owner = await t.signUp(`owner-mixed-${Date.now()}@example.com`);
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
    traits: { email: `p${i}@example.com`, firstName: `P${i}` },
  }));
  expect((await ingest(people)).status).toBe(200);
  const ids = await eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ id: string }>(
          "SELECT profile_id AS id FROM identifiers WHERE workspace_id = $1 AND type = 'user_id'",
          [ws],
        )
      ).rows,
    (rows) => rows.length === PEOPLE,
    20_000,
  );
  for (const row of ids) await client.call('consent.record', { profileId: row.id, purpose: 'marketing_email', status: 'granted' });

  template = await createPublished('email_template', 'mixed newsletter', {
    purpose: 'marketing_email',
    subject: 'The mixed subject',
    mjml: mjml('Hello {{ profile.firstName | default: "reader" }}'),
  });
  segment = await createPublished('segment', 'mixed subscribers', { condition: { consent: 'marketing_email' } });
  await client.call('segments.refresh', { artifactId: segment });
  await eventually(
    async () => (await client.call('segments.members', { artifactId: segment })).members.length,
    (n) => n === PEOPLE,
    20_000,
  );
}, 120_000);

afterEach(async () => {
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox').catch(() => {});
  await t.srv.db.admin.query('DROP FUNCTION IF EXISTS am_test_hold_outbox()').catch(() => {});
});

afterAll(async () => {
  await t?.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox').catch(() => {});
  await t?.srv.db.admin.query('DROP FUNCTION IF EXISTS am_test_hold_outbox()').catch(() => {});
  await t?.close();
});

describe('the publication barrier sees a mixed-subject provider batch (#1038)', () => {
  it('defers the staged-send canary and the subject-test winner until the batch is published', async () => {
    const s = await prepareDecisions();

    // One provider webhook batch: unsubscribes for the canary of one broadcast, clicks on the
    // sample of another.
    await holdPublication();
    await t.srv.db.withWorkspace(ws, (tx) => enqueueMessageEvents(tx, ws, mixedEvents(s)));
    // The batch is one row per broadcast now; before the fix it was a single unsubjected row.
    expect(await unsubjectedRows()).toBe(0);

    await expectDeferred(s);
    await publishAndExpect(s);
  }, 180_000);

  it('defers on a legacy mixed row written without subject_ref before the upgrade', async () => {
    const s = await prepareDecisions();

    // Exactly the shape 0.15.2 wrote: one row for the whole provider batch, with no subject_ref.
    // It stays in the queue through an upgrade, and the barrier must still see it (#1038).
    await holdPublication();
    await t.srv.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state)
       VALUES ($1, 'obx_legacy_mixed_batch', 'message_event', $2::jsonb, 'legacy-mixed-batch', 'pending')`,
      [ws, JSON.stringify({ events: mixedEvents(s) })],
    );
    expect(await unsubjectedRows()).toBe(1);

    await expectDeferred(s);
    await publishAndExpect(s);
  }, 180_000);
});

interface Scenario {
  canaryId: string;
  testId: string;
  canary: MessageRow[];
  clicked: MessageRow[];
  expectedWinner: string;
}

/** A staged send waiting on its canary and a subject test waiting on its sample, both with nothing left to publish. */
async function prepareDecisions(): Promise<Scenario> {
  const canaryId = await broadcast({
    template,
    segment,
    stagedSend: { canaryPercent: 20, wait: 'PT2H', minCanary: 5, maxUnsubscribeRate: 0.02 },
  });
  const testId = await broadcast({
    template,
    segment,
    subjectTest: { subjects: ['Mixed A', 'Mixed B'], samplePercent: 50, decideAfter: 'PT4H' },
  });

  // Both decisions are waiting on their scheduled time: the canary has gone out, and the subject
  // test has sent its whole sample.
  await eventually(
    () => status(canaryId),
    (s) => s.stage?.stage === 'canary_waiting' && s.stage.canary.queued >= 1,
    30_000,
  );
  const canary = await canaryMessages(canaryId, 20);
  await eventually(
    async () => {
      const stats = await t.srv.events.messageStats(ws, {
        since: new Date(Date.now() - 3_600_000),
        journeyId: canaryId,
        messageIds: canary.map((m) => m.id),
      });
      return stats.sent ?? 0;
    },
    (n) => n >= 5,
    30_000,
  );
  const deciding = await eventually(
    () => status(testId),
    (s) => s.test?.state === 'deciding' && s.test.variants.reduce((n, v) => n + v.sent, 0) >= 1,
    30_000,
  );
  expect(deciding.test).not.toBeNull();
  const sample = (await messagesOf(testId)).filter((m) => m.variant !== null);
  await eventually(
    () => status(testId),
    (s) => (s.test?.variants.reduce((n, v) => n + v.sent, 0) ?? 0) === sample.length,
    30_000,
  );
  // Every message of the canary and the sample must already be published, so the batch is the only
  // thing that can defer either decision.
  await flushOutbox();

  const a = sample.filter((m) => m.variant === 'A');
  const b = sample.filter((m) => m.variant === 'B');
  const expectedWinner = Math.min(a.length, b.length) >= 20 ? 'B' : 'A';
  return { canaryId, testId, canary, clicked: expectedWinner === 'B' ? b : a, expectedWinner };
}

/** The events of the provider batch: two canary unsubscribes and a click on every sample of the winning arm. */
function mixedEvents(s: Scenario): MessageEvent[] {
  const at = new Date().toISOString();
  const event = (message: MessageRow, broadcastId: string, type: MessageEvent['type'], n: number): MessageEvent => ({
    workspaceId: ws,
    messageId: message.id,
    eventId: `mixed:${type}:${message.id}:${n}`,
    type,
    at,
    profileId: message.profile_id,
    channel: 'email',
    purpose: 'marketing_email',
    provider: 'log',
    templateId: template,
    templateVersion: 1,
    journeyId: broadcastId,
    variant: message.variant ?? '',
    reason: '',
    url: type === 'clicked' ? 'https://example.com/' : '',
  });
  return [
    ...s.canary.slice(0, 2).map((m, i) => event(m, s.canaryId, 'unsubscribed', i)),
    ...s.clicked.map((m, i) => event(m, s.testId, 'clicked', i)),
  ];
}

/** Forces both decisions and checks they were deferred with no verdict taken from incomplete data. */
async function expectDeferred(s: Scenario) {
  await decideNow(s.canaryId, 'canary');
  await decideNow(s.testId, 'subject');
  await eventually(
    async () => {
      const [canaryRun, testRun] = await Promise.all([runOf(s.canaryId), runOf(s.testId)]);
      return (
        (canaryRun?.defer_count ?? 0) >= 1 &&
        (canaryRun?.lease_until?.getTime() ?? 0) > Date.now() &&
        (testRun?.defer_count ?? 0) >= 1 &&
        (testRun?.lease_until?.getTime() ?? 0) > Date.now()
      );
    },
    Boolean,
    30_000,
  );
  const held = await status(s.canaryId);
  expect(held.stage?.stage).toBe('canary_waiting');
  expect((await messagesOf(s.canaryId)).length).toBe(s.canary.length);
  expect((await status(s.testId)).test?.state).toBe('deciding');
  expect((await status(s.testId)).test?.winner).toBeNull();
}

/** Publishes the batch, then checks both decisions take their verdict from the published events. */
async function publishAndExpect(s: Scenario) {
  await releasePublication();
  await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, bus: t.srv.bus }, { batch: 1000 });
  await flushOutbox();

  await decideNow(s.canaryId, 'canary');
  await decideNow(s.testId, 'subject');
  const stopped = await eventually(
    () => status(s.canaryId),
    (status) => status.run.status === 'stopped' && status.stage?.stage === 'stopped',
    30_000,
  );
  expect(stopped.stage?.stopReason).toContain('unsubscribe rate');
  expect(stopped.stage?.unsubscribed).toBeGreaterThanOrEqual(2);
  const decided = await eventually(
    () => status(s.testId),
    (status) => status.test?.state === 'winner_sent',
    30_000,
  );
  expect(decided.test?.winner).toBe(s.expectedWinner);
}
