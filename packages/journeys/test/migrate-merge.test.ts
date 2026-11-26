import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { migrateJourney } from '../src/commands';

// #1150: journeys.migrate kept `waiting_event` when a waitEvent/goal node kept its id and kind but
// changed its event, so migrated participants waited for the removed v1 event. It also reported
// impact.people = 0 and rewrote every participant with its own UPDATE.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journeys_migrate');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const definition = (event: string) => ({
  purpose: 'marketing_email',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' } },
    { id: 'wait', kind: 'waitEvent', label: 'Orders', config: { event, timeout: 'P7D' }, next: [{ to: 'done' }, { to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
});

async function publishVersions(oldEvent: string, newEvent: string) {
  const id = newId('jrn');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: ws,
      id,
      type: 'journey',
      name: 'Event migration',
      latestVersion: 2,
      publishedVersion: 2,
    });
    await tx.insert(schema.artifactVersions).values([
      {
        workspaceId: ws,
        artifactId: id,
        number: 1,
        state: 'superseded',
        content: definition(oldEvent),
        contentHash: `hash_${id}_1`,
        authorType: 'user',
        authorId: 'user_test',
      },
      {
        workspaceId: ws,
        artifactId: id,
        number: 2,
        state: 'published',
        content: definition(newEvent),
        contentHash: `hash_${id}_2`,
        authorType: 'user',
        authorId: 'user_test',
      },
    ]);
  });
  return id;
}

async function participant(journeyId: string, version: number, node: string, status: string, waitingEvent: string | null) {
  const profileId = newId('prf');
  await d.db.withWorkspace(ws, (tx) => tx.insert(schema.profiles).values({ workspaceId: ws, id: profileId }));
  const [row] = await d.db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId,
        version,
        profileId,
        entryKey: `test:${profileId}`,
        node,
        status: status as 'ready' | 'waiting' | 'exited',
        waitingEvent,
      })
      .returning({ id: schema.journeyParticipants.id }),
  );
  return row!.id;
}

const context = (tx: unknown) => ({ tx, principal: { workspaceId: ws } }) as never;

describe.skipIf(!hasTestDatabase())('journeys.migrate follows the new wait event (#1150)', () => {
  it('moves a waiting participant to the new event instead of leaving the old one', async () => {
    const journeyId = await publishVersions('Order Placed', 'Order Completed');
    const stuck = await participant(journeyId, 1, 'wait', 'waiting', 'Order Placed');

    const out = await d.db.withWorkspace(ws, (tx) =>
      migrateJourney.handler({ artifactId: journeyId, mapping: {}, unmatched: 'stay', dryRun: false }, context(tx)),
    );

    expect(out).toMatchObject({ toVersion: 2, moved: 1, restarted: 0 });
    const after = await d.db.admin.query<{ version: number; node: string; waiting_event: string | null }>(
      'SELECT version, node, waiting_event FROM journey_participants WHERE id = $1',
      [stuck],
    );
    expect(after.rows[0]).toEqual({ version: 2, node: 'wait', waiting_event: 'Order Completed' });
  }, 60_000);

  it('reports the people on older versions as impact and names the journey touch', async () => {
    const journeyId = await publishVersions('Order Placed', 'Order Completed');
    await participant(journeyId, 1, 'wait', 'waiting', 'Order Placed');
    await participant(journeyId, 1, 'wait', 'ready', null);
    await participant(journeyId, 2, 'wait', 'waiting', 'Order Completed');
    await participant(journeyId, 1, 'done', 'exited', null);

    const impact = await d.db.withWorkspace(ws, (tx) =>
      migrateJourney.impact!({ artifactId: journeyId, mapping: {}, unmatched: 'stay', dryRun: true }, context(tx)),
    );

    expect(impact.people).toBe(2);
    expect(impact.touches?.artifacts).toEqual([{ id: journeyId, type: 'journey' }]);
    expect(impact.touches?.channels).toEqual([]);
  }, 60_000);

  it('clears the old step’s retry budget and error when a migration restarts a participant', async () => {
    const journeyId = await publishVersions('Order Placed', 'Order Completed');
    const moved = await participant(journeyId, 1, 'wait', 'waiting', 'Order Placed');
    await d.db.admin.query('UPDATE journey_participants SET attempts = 2, error = $2 WHERE id = $1', [moved, 'store unavailable']);

    const out = await d.db.withWorkspace(ws, (tx) =>
      migrateJourney.handler({ artifactId: journeyId, mapping: { wait: 'done' }, unmatched: 'stay', dryRun: false }, context(tx)),
    );

    expect(out).toMatchObject({ toVersion: 2, restarted: 1 });
    const after = await d.db.admin.query<{ node: string; status: string; attempts: number; error: string | null }>(
      'SELECT node, status, attempts, error FROM journey_participants WHERE id = $1',
      [moved],
    );
    expect(after.rows[0]).toEqual({ node: 'done', status: 'ready', attempts: 0, error: null });
  }, 60_000);
});
