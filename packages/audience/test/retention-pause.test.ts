import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore, StoredEvent } from '@agentic-marketing/events';
import { PLATFORM_EVENT } from '@agentic-marketing/ingest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { runRetentionOnce } from '../src/retention';

// #978 part 2: retention's destructive pruning of unconfirmed signups is paused. The scan still
// finds the people it used to delete (and reports the count), but nothing is removed until a
// durable activity check can replace the event-store read.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
const old = newId('prf');
const recent = newId('prf');
const anon = 'anon-retention-paused';
const calls: string[][] = [];

const onlyFormActivity: StoredEvent[] = [
  {
    eventId: 'evt_retention',
    sourceId: `frm_${'a'.repeat(32)}`,
    type: 'track',
    name: PLATFORM_EVENT.formSubmitted,
    anonymousId: anon,
    userId: '',
    timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    receivedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    properties: {},
    context: {},
  },
];

const events = {
  async eventsOfAnonymousIds(_workspaceId: string, ids: string[]) {
    calls.push(ids);
    return onlyFormActivity;
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('retention_pause');
  const ago = new Date(Date.now() - 40 * 86_400_000);
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values([
      { workspaceId: d.workspace, id: old, firstSeen: ago },
      { workspaceId: d.workspace, id: recent, firstSeen: new Date() },
    ]);
    await tx.insert(schema.identifiers).values([
      { workspaceId: d.workspace, profileId: old, type: 'anonymous_id', value: anon },
      { workspaceId: d.workspace, profileId: old, type: 'email', value: 'hash-old@example.com' },
      { workspaceId: d.workspace, profileId: recent, type: 'anonymous_id', value: 'anon-retention-recent' },
      { workspaceId: d.workspace, profileId: recent, type: 'email', value: 'hash-recent@example.com' },
    ]);
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('retention pruning is paused (#978 part 2)', () => {
  it('scans and reports an unconfirmed signup but keeps it', async () => {
    calls.length = 0;
    const result = await runRetentionOnce({
      db: d.db,
      events,
      unconfirmedDays: 30,
      logDays: 180,
    });
    expect(result).toMatchObject({ profiles: 0, unconfirmedSignups: 1 });
    // The scan really looked at the person's history; it just did not delete them.
    expect(calls).toEqual([[anon]]);
    const { rows } = await d.db.admin.query<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = $1 ORDER BY id', [d.workspace]);
    expect(rows.map((r) => r.id).sort()).toEqual([old, recent].sort());
  });
});
