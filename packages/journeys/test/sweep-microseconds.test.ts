import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1151: the sweep's candidate cursor was a `timestamptz` decoded into a JS Date, which keeps
// milliseconds only. With several due participants sharing one microsecond, the next page re-read
// the first page's rows past the id tie-breaker, so the scan spent its budget on duplicates and
// claimed fewer people than its batch. The cursor is now text at full microsecond precision.

const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws = '';

const eventStore = { async insertJourneyEvents() {} } as unknown as EventStore;
const deps = () => ({ kp, events: eventStore });

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_sweep_micros');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function seedProfile(id: string) {
  await d.db.withWorkspace(ws, (tx) => tx.insert(schema.profiles).values({ workspaceId: ws, id }));
}

async function publishJourney(): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, `Journey ${journeyId}`],
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
          { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Micros Pack' }, next: [{ to: 'done' }] },
          { id: 'done', kind: 'updateProfile', label: 'Set trait', config: { trait: 'packed', value: true }, next: [] },
        ],
      }),
      `hash_${journeyId}`,
    ],
  );
  return journeyId;
}

describe.skipIf(!hasTestDatabase())('journey sweep cursor precision (#1151)', () => {
  it('does not rescan a page whose participants share one microsecond', async () => {
    const ids = Array.from({ length: 4 }, () => newId('prf')).sort();
    for (const id of ids) await seedProfile(id);
    const journeyId = await publishJourney();
    // A bulk enrol wrote one transaction's `now()` into every row: identical to the microsecond.
    for (const [index, profileId] of ids.entries())
      await d.db.admin.query(
        `INSERT INTO journey_participants (workspace_id, journey_id, version, profile_id, entry_key, node, status, due_at)
         VALUES ($1, $2, 1, $3, $4, 'start', 'ready', '2025-12-01T00:00:00.123456Z'::timestamptz)`,
        [ws, journeyId, profileId, `micro:${index}:${journeyId}`],
      );

    // The lowest id is held by another batch, as a concurrent write would. With a two-person batch
    // the first page is [locked, free]; a truncated cursor re-reads both as page two, so the
    // duplicate free id fills the batch and only one participant moves.
    const probe = await d.db.admin.connect();
    let moved = 0;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [ws, ids[0]]);
      moved = await sweep(d.db, deps(), { batch: 2 });
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }

    expect(moved).toBe(2);
    const { rows } = await d.db.admin.query<{ profile_id: string; status: string }>(
      'SELECT profile_id, status FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2 ORDER BY profile_id',
      [ws, journeyId],
    );
    expect(rows.map((r) => r.status)).toEqual(['ready', 'completed', 'completed', 'ready']);
  }, 120_000);
});
