import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1011 review: one sweep examines a bounded number of due candidates. A run of people a batch is
// writing right now must not let a sweep walk a whole workspace backlog, and the next sweep must
// resume after that run so the due person behind it is still reached.

const MASTER_KEY = Buffer.alloc(32, 46).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

const eventStore = { async insertJourneyEvents() {} } as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_sweep_budget');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

async function publishedJourney(name: string): Promise<string> {
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
          { id: 'start', kind: 'trigger', label: 'Start', config: { event: name }, next: [{ to: 'done' }] },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      }),
      `hash_${journeyId}`,
    ],
  );
  return journeyId;
}

describe.skipIf(!hasTestDatabase())('a sweep scans a bounded number of candidates (#1011 review)', () => {
  it('stops at its budget and the next sweep resumes past the locked run', async () => {
    const journeyId = await publishedJourney('Sweep Budget');
    // Twelve people a batch is writing right now, all due before a free one behind them.
    const people = Array.from({ length: 13 }, () => newId('prf'));
    const locked = people.slice(0, 12);
    const free = people[12]!;
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values(people.map((id) => ({ workspaceId: ws, id })));
      const base = Date.UTC(2025, 11, 1);
      await tx.insert(schema.journeyParticipants).values(
        people.map((id, i) => ({
          workspaceId: ws,
          journeyId,
          version: 1,
          profileId: id,
          entryKey: `budget:${id}`,
          node: 'start',
          status: 'ready' as const,
          dueAt: new Date(base + i * 60_000),
        })),
      );
    });
    const participantOf = async (id: string) => {
      const { rows } = await d.db.admin.query<{ status: string }>(
        'SELECT status FROM journey_participants WHERE workspace_id = $1 AND profile_id = $2',
        [ws, id],
      );
      return rows[0];
    };

    const probe = await d.db.admin.connect();
    try {
      await probe.query('BEGIN');
      for (const id of locked) await probe.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [ws, id]);
      // A batch of one gets a scan budget of a few candidates: it cannot examine the whole run, so
      // it must come back empty rather than walking the workspace backlog.
      expect(await sweep(d.db, { kp, events: eventStore }, { batch: 1 })).toBe(0);
      expect(await participantOf(free)).toMatchObject({ status: 'ready' });

      // The next sweep continues after the run it stopped in and reaches the due person behind it.
      expect(await sweep(d.db, { kp, events: eventStore }, { batch: 1 })).toBe(1);
      expect(await participantOf(free)).toMatchObject({ status: 'completed' });
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
  }, 120_000);
});
