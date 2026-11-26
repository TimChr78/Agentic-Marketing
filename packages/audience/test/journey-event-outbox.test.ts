import { newId } from '@agentic-marketing/core';
import { enqueueOutbox } from '@agentic-marketing/db';
import type { EventStore, JourneyEvent } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { dispatchOutboxOnce } from '../src/outboxDispatcher';

// #1244: journey events queued by the sweep are published by the dispatcher with retries. A
// ClickHouse outage must back the row off instead of losing its events, and a redelivery must not
// write them twice (the stable operation key keeps one row; the ClickHouse table replaces a
// duplicate within a row anyway).

const MASTER_KEY = Buffer.alloc(32, 46).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

let attempts = 0;
const offered: JourneyEvent[][] = [];
let down = true;
const store = {
  async insertJourneyEvents(events: JourneyEvent[]) {
    attempts++;
    offered.push(events);
    if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_event_dispatch');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 180_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<JourneyEvent>): JourneyEvent => ({
  workspaceId: ws,
  journeyId: newId('jrn'),
  version: 1,
  participantId: 1,
  profileId: newId('prf'),
  node: 'split',
  type: 'step',
  seq: 1,
  at: new Date().toISOString(),
  detail: 'variant 1',
  ...over,
});

describe.skipIf(!hasTestDatabase())('the outbox publishes journey events with retries (#1244)', () => {
  it('retries a failed insert and delivers the batch once', async () => {
    const events = [
      event({ type: 'entered', detail: '' }),
      event({ type: 'step', detail: 'variant 1' }),
      event({ type: 'completed', detail: '' }),
    ];
    const operationKey = `journey-event:${newId('test')}`;
    await d.db.withWorkspace(ws, (tx) =>
      enqueueOutbox(tx, ws, { kind: 'journey_event', operationKey, subjectRef: events[0]!.journeyId, payload: { events } }),
    );
    // The same action enqueues nothing new (the stable-key dedupe the sweep relies on).
    await d.db.withWorkspace(ws, (tx) =>
      enqueueOutbox(tx, ws, { kind: 'journey_event', operationKey, subjectRef: events[0]!.journeyId, payload: { events } }),
    );
    const { rows: queued } = await d.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND kind = 'journey_event'",
      [ws],
    );
    expect(queued[0]?.n).toBe(1);

    // ClickHouse is down: the row backs off and keeps its events.
    const first = await dispatchOutboxOnce({ db: d.db, kp, events: store, bus: {} as never });
    expect(first.retried).toBe(1);
    expect(attempts).toBe(1);
    expect(offered[0]).toEqual(events);
    const { rows: pending } = await d.db.admin.query<{ state: string }>(
      "SELECT state FROM outbox WHERE workspace_id = $1 AND kind = 'journey_event'",
      [ws],
    );
    expect(pending[0]?.state).toBe('pending');

    // ClickHouse is back: the retry publishes the same events once and settles the row.
    down = false;
    await d.db.admin.query("UPDATE outbox SET next_attempt_at = now() WHERE workspace_id = $1 AND kind = 'journey_event'", [ws]);
    const second = await dispatchOutboxOnce({ db: d.db, kp, events: store, bus: {} as never });
    expect(second.delivered).toBe(1);
    expect(attempts).toBe(2);
    expect(offered[1]).toEqual(events);

    // Nothing is offered a third time.
    const third = await dispatchOutboxOnce({ db: d.db, kp, events: store, bus: {} as never });
    expect(third.claimed).toBe(0);
    expect(attempts).toBe(2);
  }, 120_000);
});
