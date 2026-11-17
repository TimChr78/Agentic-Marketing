import { newId } from '@agentic-marketing/core';
import type { EventStore } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { runRetentionOnce } from '../src/retention';

// #1011 review: the journey hook's per-event markers only suppress a redelivery while the event
// stream can still deliver the event again (JetStream keeps an event for at most 30 days). Older
// markers are dead weight and are pruned in a bounded batch by the scheduler's retention round.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
const oldMarker = { eventId: 'customer@example.test:old-1', profileId: newId('prf') };
const recentMarker = { eventId: 'customer@example.test:recent-1', profileId: newId('prf') };

/** Retention would only read the event store for unconfirmed-signup candidates; there are none. */
const events = {
  async eventsOfAnonymousIds() {
    throw new Error('no profile should be inspected in this test');
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('retention_journey_markers');
  await d.db.admin.query(
    `INSERT INTO journey_processed_events (workspace_id, profile_id, event_id, processed_at) VALUES
       ($1, $2, $3, now() - make_interval(days => 40)),
       ($1, $4, $5, now() - make_interval(days => 1))`,
    [d.workspace, oldMarker.profileId, oldMarker.eventId, recentMarker.profileId, recentMarker.eventId],
  );
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('journey event markers expire with their replay window (#1011 review)', () => {
  it('prunes markers older than the window and keeps the ones a redelivery can still need', async () => {
    const result = await runRetentionOnce({ db: d.db, events, unconfirmedDays: 30, logDays: 180 });
    expect(result.journeyEventMarkers).toBe(1);
    const { rows } = await d.db.admin.query<{ event_id: string }>('SELECT event_id FROM journey_processed_events WHERE workspace_id = $1', [
      d.workspace,
    ]);
    expect(rows).toEqual([{ event_id: recentMarker.eventId }]);
  }, 60_000);
});
