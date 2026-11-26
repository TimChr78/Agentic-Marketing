import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore, JourneyEvent } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1244: the sweep committed its participant state and then wrote the journey events to ClickHouse
// once, best effort, outside the transaction. A failed insert lost the split take, the goal
// conversion and the step counts for good. They must be queued in the sweep transaction so a
// dispatcher can retry them; the audience project's journey-event-outbox test publishes them.

const MASTER_KEY = Buffer.alloc(32, 46).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

let attempts = 0;
const store = {
  async insertJourneyEvents() {
    attempts++;
    throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
  },
  async countEvents() {
    return [];
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_event_outbox');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 180_000);

afterAll(async () => {
  await d?.close();
});

async function publishedJourney(name: string, nodes: unknown[]): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, name],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [ws, journeyId, JSON.stringify({ purpose: 'marketing_email', nodes }), `hash_${journeyId}`],
  );
  return journeyId;
}

const start = { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' } };
const done = { id: 'done', kind: 'exit', label: 'Done', config: {} };

describe.skipIf(!hasTestDatabase())('the sweep queues its journey events durably (#1244)', () => {
  it('writes them to the outbox in the same transaction, without a direct ClickHouse write', async () => {
    const goal = await publishedJourney('Goal', [
      { ...start, next: [{ to: 'goal' }] },
      {
        id: 'goal',
        kind: 'goal',
        label: 'Bought?',
        config: { event: 'Order Completed', within: 'P0D' },
        next: [{ to: 'done' }, { to: 'done' }],
      },
      done,
    ]);
    const arms = await publishedJourney('Split', [
      { ...start, next: [{ to: 'split' }] },
      { id: 'split', kind: 'split', label: 'A/B', config: { weights: [50, 50] }, next: [{ to: 'done' }, { to: 'done' }] },
      done,
    ]);
    const past = new Date(Date.now() - 60_000);
    const people = Array.from({ length: 4 }, () => newId('prf'));
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values(people.map((id) => ({ workspaceId: ws, id })));
      await tx.insert(schema.journeyParticipants).values(
        people.slice(0, 3).map((profileId, i) => ({
          workspaceId: ws,
          journeyId: goal,
          version: 1,
          profileId,
          entryKey: `outbox:goal:${i}`,
          node: 'goal',
          seq: 2,
          status: 'waiting' as const,
          dueAt: past,
          waitingEvent: 'Order Completed',
          context: {},
        })),
      );
      await tx.insert(schema.journeyParticipants).values({
        workspaceId: ws,
        journeyId: arms,
        version: 1,
        profileId: people[3]!,
        entryKey: 'outbox:split',
        node: 'start',
        status: 'ready',
        dueAt: past,
        context: {},
      });
    });

    expect(await sweep(d.db, { kp, events: store })).toBe(4);
    const { rows: participants } = await d.db.admin.query<{ status: string }>(
      'SELECT status FROM journey_participants WHERE workspace_id = $1 AND journey_id = ANY($2::text[])',
      [ws, [goal, arms]],
    );
    expect(participants.filter((r) => r.status === 'completed')).toHaveLength(4);
    // The sweep never touched ClickHouse, and nothing was lost: the events wait in the outbox.
    expect(attempts).toBe(0);
    const { rows: queued } = await d.db.admin.query<{ state: string; subject_ref: string; payload: { events: JourneyEvent[] } }>(
      "SELECT state, subject_ref, payload FROM outbox WHERE workspace_id = $1 AND kind = 'journey_event' ORDER BY subject_ref",
      [ws],
    );
    expect(queued).toHaveLength(2);
    expect(queued.every((r) => r.state === 'pending')).toBe(true);
    expect(queued.map((r) => r.subject_ref).sort()).toEqual([goal, arms].sort());

    const events = queued.flatMap((r) => r.payload.events);
    expect(events).toHaveLength(14);
    const kinds = events.map((e) => `${e.journeyId}:${e.type}:${e.detail}`);
    const ofGoal = kinds.filter((k) => k.startsWith(goal));
    expect(ofGoal.filter((k) => k.endsWith(':resumed:'))).toHaveLength(3);
    expect(ofGoal.filter((k) => k.endsWith(':completed:'))).toHaveLength(3);
    const ofArms = kinds.filter((k) => k.startsWith(arms));
    expect(ofArms.filter((k) => k.endsWith(':entered:'))).toHaveLength(1);
    expect(ofArms.filter((k) => /:step:variant [12]$/.test(k))).toHaveLength(1);
    expect(ofArms.filter((k) => k.endsWith(':step:'))).toHaveLength(2);

    // A second sweep moves nothing and queues nothing new.
    expect(await sweep(d.db, { kp, events: store })).toBe(0);
    const { rows: after } = await d.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND kind = 'journey_event'",
      [ws],
    );
    expect(after[0]?.n).toBe(2);
  }, 120_000);
});
