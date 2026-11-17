import { evaluateAlerts, resetAlertEvaluationState } from '@agentic-marketing/alerts';
import { enqueueOutbox } from '@agentic-marketing/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1008: alerts evaluate published data. While the outbox still owes ClickHouse message events, a
// quiet rule describes incomplete data, not health, so every sweep reports the publication lag and
// dead letters beside its decisions.

const PORT = testPort(2654);
const MINUTE = 60_000;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const deps = () => ({
  db: t.srv.db,
  events: t.srv.events,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});

const api = () => t.api(owner, ws);

/** A message event for a send whose publication has not happened: only the ids matter here. */
const event = (messageId: string) => ({
  workspaceId: ws,
  messageId,
  eventId: `test:${messageId}`,
  type: 'bounced' as const,
  at: new Date().toISOString(),
  profileId: `prf_${'a'.repeat(32)}`,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'log',
  templateId: `eml_${'b'.repeat(32)}`,
  templateVersion: 1,
  journeyId: '',
  reason: 'synthetic',
  url: '',
});

/** Enqueues a row through the production path, then lets the test place it in time. */
async function enqueue(operationKey: string, kind = 'message_event') {
  return t.srv.db.withWorkspace(ws, (tx) =>
    enqueueOutbox(tx, ws, {
      kind,
      operationKey,
      payload: kind === 'message_event' ? { events: [event(`msg_${operationKey}`)] } : { profileId: 'prf_x' },
    }),
  );
}

/**
 * Holds every row this workspace enqueues an hour out, so the dispatcher cannot publish it: the
 * queue state an outage leaves, without a sleep or a race with the background dispatcher.
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

beforeAll(async () => {
  t = await startTestServer('test_alert_publication', PORT);
  owner = await t.signUp(`owner-alert-publication-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  // A rule that never has enough volume to decide on in this test: it stays "not firing" whatever
  // the lag is, which is exactly the quiet alert the report must qualify.
  await api().call('alerts.create', {
    name: 'Bounce rate over 5%',
    kind: 'deliverability',
    config: { metric: 'bounce', window: 'PT1H', threshold: 0.05, minSent: 100 },
    channels: [{ type: 'email', userIds: [owner.id] }],
  });
}, 60_000);

afterAll(() => t?.close());

afterEach(async () => {
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox').catch(() => {});
  await t.srv.db.admin.query('DROP FUNCTION IF EXISTS am_test_hold_outbox()').catch(() => {});
  await t.srv.db.admin.query("DELETE FROM outbox WHERE workspace_id = $1 AND operation_key LIKE 'freshness-%'", [ws]);
  resetAlertEvaluationState();
});

describe('alert evaluation reports publication lag (#1008)', () => {
  it('reports the oldest unpublished message event while a quiet rule is evaluated on published data', async () => {
    await holdPublication();
    const pendingA = await enqueue('freshness-pending-a');
    await enqueue('freshness-pending-b');
    const dead = await enqueue('freshness-dead');
    // A stuck double opt-in confirmation says nothing about a deliverability read, so it is not
    // part of this lag.
    await enqueue('freshness-doi', 'doi_send');

    await t.srv.db.admin.query(
      `UPDATE outbox SET created_at = now() - interval '20 minutes' WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [ws, [pendingA.id, dead.id]],
    );
    await t.srv.db.admin.query(`UPDATE outbox SET created_at = now() - interval '2 hours' WHERE workspace_id = $1 AND id = $2`, [
      ws,
      dead.id,
    ]);
    await t.srv.db.admin.query(`UPDATE outbox SET created_at = now() - interval '3 hours' WHERE workspace_id = $1 AND kind = 'doi_send'`, [
      ws,
    ]);
    // The dead letter is what an exhausted row looks like after its retries.
    await t.srv.db.admin.query(
      `UPDATE outbox SET state = 'failed', failure_kind = 'exhausted', attempts = 36, last_error = 'ClickHouse unavailable'
       WHERE workspace_id = $1 AND id = $2`,
      [ws, dead.id],
    );

    const { rows } = await t.srv.db.admin.query<{ oldest: Date }>(
      `SELECT min(created_at) AS oldest FROM outbox
       WHERE workspace_id = $1 AND state IN ('pending', 'delivering') AND kind = 'message_event'`,
      [ws],
    );
    const oldest = rows[0]?.oldest;
    expect(oldest).toBeInstanceOf(Date);

    // A fixed clock exactly 20 minutes after the oldest row was enqueued: no sleeping, and the age
    // is the value the sweep must report.
    const result = await evaluateAlerts(deps(), { now: new Date(oldest.getTime() + 20 * MINUTE), force: true });
    expect(result.workspaces).toBe(1);
    expect(result.publication).toEqual({ outstanding: 2, failed: 1, oldestPendingAgeMs: 20 * MINUTE });

    // The rule still evaluated published data and stayed quiet...
    const listed = await api().call('alerts.list', {});
    expect(listed.rules[0]).toMatchObject({ name: 'Bounce rate over 5%', state: 'ok' });
    // ...and the listing says how far publication is behind, so "not firing" is not read as health.
    expect(listed.publication).toMatchObject({ outstanding: 2, failed: 1 });
    expect(listed.publication.oldestPendingAgeMs).toBeGreaterThanOrEqual(20 * MINUTE);
    expect(listed.publication.oldestPendingAgeMs).toBeLessThan(21 * MINUTE);
  }, 60_000);

  it('reports dead-lettered rows as failed and stops reporting lag once publication settles', async () => {
    await holdPublication();
    const dead = await enqueue('freshness-only-dead');
    await t.srv.db.admin.query(
      `UPDATE outbox SET state = 'failed', failure_kind = 'exhausted', attempts = 36 WHERE workspace_id = $1 AND id = $2`,
      [ws, dead.id],
    );
    const failing = await evaluateAlerts(deps(), { force: true });
    expect(failing.publication).toEqual({ outstanding: 0, failed: 1, oldestPendingAgeMs: null });
    expect((await api().call('alerts.list', {})).publication).toEqual({ outstanding: 0, failed: 1, oldestPendingAgeMs: null });

    // A settled queue is an empty report, not a null one.
    await t.srv.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    const settled = await evaluateAlerts(deps(), { force: true });
    expect(settled.publication).toEqual({ outstanding: 0, failed: 0, oldestPendingAgeMs: null });
    expect((await api().call('alerts.list', {})).publication).toEqual({ outstanding: 0, failed: 0, oldestPendingAgeMs: null });
  }, 60_000);
});
