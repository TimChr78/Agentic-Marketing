import type { AlertNotification, DeliveryStatus } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { NotifyDeps } from '../src/deps';
import { pendingChannels, reconcileQueuedAlertEvents } from '../src/evaluate';
import { MAX_ALERT_DELIVERY_CYCLES, type NotifyInput, notifyChannels, reconcileAlertNotifications } from '../src/notify';

// #368: a webhook is `queued` until the outbox completed it, `failed` after it died, and a dead
// delivery is retried by re-opening the same row for a bounded number of cycles. No duplicate
// queued row, no reset of an in-flight attempt, and a resolved/disabled rule still reconciles.

const RULE_ID = `alr_${'a'.repeat(32)}`;
const WEBHOOK_ID = `whk_${'b'.repeat(32)}`;
const AT = new Date('2026-11-04T09:00:00.000Z');

const deps = {
  // Webhook-only paths never touch the key provider, e-mail or directory.
  kp: {} as NotifyDeps['kp'],
  email: {} as NotifyDeps['email'],
  directory: { users: async () => new Map() },
  publicUrl: 'https://admin.example.com',
} satisfies NotifyDeps;

const input = (eventId: string, event: NotifyInput['event'] = 'firing'): NotifyInput => ({
  workspace: { id: '', name: 'Ops test' },
  rule: {
    id: RULE_ID,
    name: 'Bounce rate',
    kind: 'deliverability',
    config: { metric: 'bounce', window: 'PT24H', threshold: 0.05, minSent: 100 },
  },
  eventId,
  event,
  value: 0.08,
  threshold: 0.05,
  window: 'PT24H',
  now: AT,
});

let t: DisposableDb;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  t = await createDisposableDb('alerts');
  await t.db.admin.query(
    `INSERT INTO webhook_endpoints (workspace_id, id, name, url, events, secrets, secrets_key_id)
     VALUES ($1, $2, 'Ops hook', 'https://hooks.example.com/alert', '{}', $3, 'test')`,
    [t.workspace, WEBHOOK_ID, Buffer.alloc(0)],
  );
  await t.db.admin.query(
    `INSERT INTO alert_rules (workspace_id, id, name, kind, config, channels, enabled, created_by)
     VALUES ($1, $2, 'Bounce rate', 'deliverability', '{}', $3, true, 'test')`,
    [t.workspace, RULE_ID, JSON.stringify([{ type: 'webhook', webhookId: WEBHOOK_ID }])],
  );
}, 120_000);

afterAll(async () => {
  if (t) await t.close();
});

const send = (eventId: string, existing: AlertNotification[] = [], event: NotifyInput['event'] = 'firing') =>
  t.db.withWorkspace(t.workspace, (tx) =>
    notifyChannels(
      tx,
      deps,
      { ...input(eventId, event), workspace: { id: t.workspace, name: 'Ops test' } },
      [{ type: 'webhook', webhookId: WEBHOOK_ID }],
      existing,
    ),
  );

const reconcile = (notified: AlertNotification[]) => t.db.withWorkspace(t.workspace, (tx) => reconcileAlertNotifications(tx, notified));

const deliveryRows = async (idempotencyKey: string) =>
  (
    await t.db.admin.query<{ id: string; status: DeliveryStatus; attempts: number; error: string | null }>(
      'SELECT id, status, attempts, error FROM deliveries WHERE workspace_id = $1 AND idempotency_key = $2',
      [t.workspace, idempotencyKey],
    )
  ).rows;

const setDelivery = (id: string, status: DeliveryStatus, attempts: number, error: string | null = null) =>
  t.db.admin.query('UPDATE deliveries SET status = $2, attempts = $3, error = $4 WHERE id = $1', [id, status, attempts, error]);

describe.skipIf(!hasTestDatabase())('alert notifications follow the delivery (#368)', () => {
  it('records queued, never sent, while the outbox only has a pending row', async () => {
    const key = `alert:evt_queued:firing:${WEBHOOK_ID}`;
    const [notification] = await send('evt_queued');
    expect(notification).toMatchObject({ channel: 'webhook', target: WEBHOOK_ID, status: 'queued', attempts: 0 });
    expect(notification?.deliveryId).toBeTruthy();
    expect(notification?.status).not.toBe('sent');
    const rows = await deliveryRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });

    // A second tick while queued must not insert another row or reset attempts.
    await setDelivery(notification!.deliveryId!, 'running', 2);
    const [again] = await send('evt_queued', [notification!]);
    expect(again).toMatchObject({ status: 'queued', attempts: 2 });
    expect(await deliveryRows(key)).toHaveLength(1);
    expect((await deliveryRows(key))[0]).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('becomes sent only after the outbox completed, and a sent channel is not enqueued again', async () => {
    const [initial] = await send('evt_done');
    await setDelivery(initial!.deliveryId!, 'done', 1);
    const [reconciled] = await reconcile([initial!]);
    expect(reconciled).toMatchObject({ status: 'sent', attempts: 1 });
    expect(pendingChannels([{ type: 'webhook', webhookId: WEBHOOK_ID }], [reconciled!], 'firing')).toEqual([]);
    expect(await deliveryRows(`alert:evt_done:firing:${WEBHOOK_ID}`)).toHaveLength(1);
  });

  it('marks an exhausted delivery failed, re-opens the same row for a bounded retry, then stops', async () => {
    const key = `alert:evt_dead:firing:${WEBHOOK_ID}`;
    const [initial] = await send('evt_dead');
    await setDelivery(initial!.deliveryId!, 'dead', 7, 'HTTP 500');
    const [failed] = await reconcile([initial!]);
    expect(failed).toMatchObject({ status: 'failed', retryable: true, error: 'HTTP 500' });
    expect(failed?.cycles).toBe(1);
    // A failed-but-retryable webhook is selected again.
    expect(pendingChannels([{ type: 'webhook', webhookId: WEBHOOK_ID }], [failed!], 'firing')).toHaveLength(1);

    const [retried] = await send('evt_dead', [failed!]);
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, cycles: 2 });
    const rows = await deliveryRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0, error: null });

    // The retry cycle exhausts too: the notification becomes a permanent failure.
    await setDelivery(retried!.deliveryId!, 'dead', 7, 'HTTP 500');
    const [failedAgain] = await reconcile([retried!]);
    expect(failedAgain).toMatchObject({ status: 'failed', retryable: false, cycles: 2 });
    const [exhausted] = await send('evt_dead', [failedAgain!]);
    expect(exhausted).toMatchObject({
      status: 'failed',
      retryable: false,
      cycles: MAX_ALERT_DELIVERY_CYCLES,
    });
    expect(pendingChannels([{ type: 'webhook', webhookId: WEBHOOK_ID }], [exhausted!], 'firing')).toEqual([]);
    expect(await deliveryRows(key)).toHaveLength(1);
  });

  it('keeps its retry budget when the ledger entry is missing', async () => {
    const [initial] = await send('evt_missing_ledger');
    await setDelivery(initial!.deliveryId!, 'dead', 7, 'unavailable');
    const [retried] = await send('evt_missing_ledger');
    expect(retried).toMatchObject({ status: 'queued', cycles: 2 });
    await setDelivery(initial!.deliveryId!, 'dead', 7, 'unavailable');
    const [terminal] = await send('evt_missing_ledger');
    expect(terminal).toMatchObject({ status: 'failed', retryable: false, cycles: 2 });
    expect((await deliveryRows(`alert:evt_missing_ledger:firing:${WEBHOOK_ID}`))[0]).toMatchObject({ status: 'dead', attempts: 7 });
  });

  it('records a disabled endpoint as failed and does not retry it automatically', async () => {
    await t.db.admin.query('UPDATE webhook_endpoints SET enabled = false WHERE id = $1', [WEBHOOK_ID]);
    try {
      const [notification] = await send('evt_disabled');
      expect(notification).toMatchObject({ status: 'failed', retryable: false });
    } finally {
      await t.db.admin.query('UPDATE webhook_endpoints SET enabled = true WHERE id = $1', [WEBHOOK_ID]);
    }
  });

  it('reconciles a queued notification on a resolved event even when the rule is disabled', async () => {
    const eventId = `ale_${'c'.repeat(32)}`;
    const [initial] = await send('evt_resolved');
    await setDelivery(initial!.deliveryId!, 'dead', 7, 'HTTP 500');
    await t.db.admin.query('UPDATE alert_rules SET enabled = false WHERE id = $1', [RULE_ID]);
    try {
      await t.db.admin.query(
        `INSERT INTO alert_events (workspace_id, id, rule_id, state, value, threshold, "window", fired_at, resolved_at, notified)
         VALUES ($1, $2, $3, 'resolved', 0.08, 0.05, 'PT24H', $4, $4, $5)`,
        [t.workspace, eventId, RULE_ID, AT, JSON.stringify(await reconcile([initial!]))],
      );
      const changed = await reconcileQueuedAlertEvents({ db: t.db, events: {} as never, ...deps });
      expect(changed).toBe(1);
      const { rows } = await t.db.admin.query<{ notified: AlertNotification[] }>('SELECT notified FROM alert_events WHERE id = $1', [
        eventId,
      ]);
      expect(rows[0]?.notified[0]).toMatchObject({ status: 'queued', cycles: 2 });
      expect((await deliveryRows(`alert:evt_resolved:firing:${WEBHOOK_ID}`))[0]).toMatchObject({ status: 'pending', attempts: 0 });
      await setDelivery(initial!.deliveryId!, 'done', 1);
      await reconcileQueuedAlertEvents({ db: t.db, events: {} as never, ...deps });
      const sent = await t.db.admin.query<{ notified: AlertNotification[] }>('SELECT notified FROM alert_events WHERE id = $1', [eventId]);
      expect(sent.rows[0]?.notified[0]).toMatchObject({ status: 'sent', cycles: 2 });
    } finally {
      await t.db.admin.query('UPDATE alert_rules SET enabled = true WHERE id = $1', [RULE_ID]);
    }
  });
});

describe('pending channels', () => {
  const note = (overrides: Partial<AlertNotification>): AlertNotification => ({
    event: 'firing',
    channel: 'email',
    target: 'usr_1',
    at: AT.toISOString(),
    status: 'sent',
    ...overrides,
  });

  it('keeps successful e-mail recipients, retries failed ones and skips queued ones', () => {
    const notified = [
      note({ target: 'usr_sent' }),
      note({ target: 'usr_failed', status: 'failed', error: 'provider_error' }),
      note({ target: 'usr_queued', status: 'queued' }),
      note({ target: 'usr_exhausted', status: 'failed', retryable: false }),
      note({ target: 'whk_queued', channel: 'webhook', status: 'queued' }),
    ];
    expect(
      pendingChannels(
        [
          { type: 'email', userIds: ['usr_sent', 'usr_failed', 'usr_queued', 'usr_exhausted'] },
          { type: 'webhook', webhookId: 'whk_queued' },
        ],
        notified,
        'firing',
      ),
    ).toEqual([{ type: 'email', userIds: ['usr_failed'] }]);
  });

  it('does not carry a firing decision over to the resolved event', () => {
    expect(pendingChannels([{ type: 'email', userIds: ['usr_1'] }], [note({ status: 'sent' })], 'resolved')).toEqual([
      { type: 'email', userIds: ['usr_1'] },
    ]);
  });
});
