import { dispatchOutboxOnce, withEmailProfileEvents } from '@agentic-marketing/audience';
import { newId } from '@agentic-marketing/core';
import { JOURNEY_EVENT_MAX_AGE_DAYS, requeueFailedOutbox, schema } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore, MessageEvent } from '@agentic-marketing/events';
import { journeyHook } from '@agentic-marketing/journeys';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';

// #1027 review: a `message_event` outbox row publishes the customer events a journey trigger sees.
// The row now carries the time it was queued, and the dispatcher publishes with it, so a row that is
// delivered late — or requeued by `am outbox` after its retries — keeps the delivery age it had
// instead of looking freshly received. Once that age is past the journey hook's bound, the journey
// trigger in it is refused, and requeueing cannot revive it.

const DAY_MS = 24 * 60 * 60 * 1000;
const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;
let profileId: string;
let journeyId: string;

const eventStore = { async insertJourneyEvents() {} } as unknown as EventStore;
const deps = () => ({ kp: localKeyProvider(MASTER_KEY), events: eventStore });

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_age_outbox');
  ws = d.workspace;
  profileId = newId('prf');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id: profileId });
    await tx.insert(schema.identifiers).values({ workspaceId: ws, profileId, type: 'anonymous_id', value: `anon-${profileId}` });
  });
  journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', 'Clicked Journey', 1, 1)`,
    [ws, journeyId],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [
      ws,
      journeyId,
      JSON.stringify({
        purpose: 'marketing_email',
        nodes: [
          {
            id: 'start',
            kind: 'trigger',
            label: 'Clicked',
            config: { event: 'Email Link Clicked', reentry: 'after_exit' },
            next: [{ to: 'done' }],
          },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      }),
      `hash_${journeyId}`,
    ],
  );
}, 120_000);

beforeEach(async () => {
  if (!hasTestDatabase()) return;
  await d.db.admin.query('DELETE FROM journey_participants WHERE workspace_id = $1', [ws]);
  await d.db.admin.query('DELETE FROM journey_processed_events WHERE workspace_id = $1', [ws]);
});

afterAll(async () => {
  await d?.close();
});

const messageEvent = (at: string): MessageEvent => ({
  workspaceId: ws,
  messageId: newId('msg'),
  eventId: newId('evt'),
  type: 'clicked',
  at,
  profileId,
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'ses',
  templateId: 'eml_test',
  templateVersion: 1,
  journeyId: 'bct_test',
  reason: '',
  url: 'https://example.test/x',
});

/** A queued row whose payload has or lacks the queued time, as the two releases write it. */
async function enqueueRow(opts: { payload: Record<string, unknown>; createdAt: Date }): Promise<string> {
  const id = newId('obx');
  await d.db.admin.query(
    `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts, created_at, next_attempt_at)
     VALUES ($1, $2, 'message_event', $3::jsonb, $4, 'pending', 0, $5, now())`,
    [ws, id, JSON.stringify(opts.payload), `message-event:test:${id}`, opts.createdAt],
  );
  return id;
}

/** One dispatcher round with a recording bus; returns the carrier events it published. */
async function dispatch(): Promise<BusEvent[]> {
  const published: BusEvent[] = [];
  const bus = {
    publish: async (events: BusEvent[]) => {
      published.push(...events);
      return { accepted: events.length, duplicates: 0 };
    },
  } as unknown as EventBus;
  const store = { insertMessageEvents: async () => {} } as unknown as EventStore;
  const result = await dispatchOutboxOnce({
    db: d.db,
    kp: localKeyProvider(MASTER_KEY),
    events: withEmailProfileEvents(store, { db: d.db, bus }),
    bus,
  });
  expect(result.delivered).toBe(1);
  return published;
}

const participants = async (): Promise<number> => {
  const { rows } = await d.db.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2',
    [ws, journeyId],
  );
  return rows[0]?.n ?? 0;
};

describe.skipIf(!hasTestDatabase())('a message_event keeps its queued time through the outbox (#1027 review)', () => {
  it('refuses a row queued past the bound, even after `am outbox` requeues it', async () => {
    const queuedAt = new Date(Date.now() - (JOURNEY_EVENT_MAX_AGE_DAYS + 1) * DAY_MS);
    const row = await enqueueRow({
      payload: { events: [messageEvent(queuedAt.toISOString())], receivedAt: queuedAt.toISOString() },
      createdAt: queuedAt,
    });

    const first = await dispatch();
    expect(first).toHaveLength(1);
    // The carrier event keeps the age the batch had when it was queued, not the delivery time.
    expect(first[0]?.receivedAt).toBe(queuedAt.toISOString());
    await journeyHook(d.db, deps())(ws, [{ event: first[0]!, profileId }]);
    expect(await participants()).toBe(0);

    // `am outbox` resets attempts and state, never the row's age: the trigger stays refused.
    await d.db.admin.query(
      `UPDATE outbox SET state = 'failed', failure_kind = 'exhausted', last_error = 'ClickHouse unavailable' WHERE id = $1`,
      [row],
    );
    await expect(requeueFailedOutbox(d.db, { kind: 'message_event' })).resolves.toEqual({ requeued: 1, skippedPermanent: 0 });

    const again = await dispatch();
    expect(again).toHaveLength(1);
    expect(again[0]?.receivedAt).toBe(queuedAt.toISOString());
    await journeyHook(d.db, deps())(ws, [{ event: again[0]!, profileId }]);
    expect(await participants()).toBe(0);
  }, 120_000);

  it('falls back to the row creation time for a row queued before the payload carried one', async () => {
    const queuedAt = new Date(Date.now() - (JOURNEY_EVENT_MAX_AGE_DAYS + 2) * DAY_MS);
    await enqueueRow({ payload: { events: [messageEvent(queuedAt.toISOString())] }, createdAt: queuedAt });

    const published = await dispatch();
    expect(published).toHaveLength(1);
    // Older rows are not treated as fresh: the row's own creation time is the best evidence left.
    expect(Math.abs(Date.parse(published[0]?.receivedAt ?? '') - queuedAt.getTime())).toBeLessThan(2_000);
    await journeyHook(d.db, deps())(ws, [{ event: published[0]!, profileId }]);
    expect(await participants()).toBe(0);
  }, 120_000);

  it('still enrols from a row queued inside the bound', async () => {
    const queuedAt = new Date();
    await enqueueRow({
      payload: { events: [messageEvent(queuedAt.toISOString())], receivedAt: queuedAt.toISOString() },
      createdAt: queuedAt,
    });

    const published = await dispatch();
    await journeyHook(d.db, deps())(ws, [{ event: published[0]!, profileId }]);

    expect(await participants()).toBe(1);
  }, 120_000);
});
