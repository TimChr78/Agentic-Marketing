import { newId } from '@agentic-marketing/core';
import { enqueueOutbox } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { dispatchOutboxOnce } from '../src';

// #1102: a `segment_change` outbox row carries the Segment Entered/Exited events a list change
// publishes. It is validated in full, like a `message_event` row: a row from an older or corrupt
// release is failed permanently and stays visible instead of reaching subscribers half-formed.

const MASTER_KEY = Buffer.alloc(32, 19).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
const published: BusEvent[] = [];
const bus = {
  async publish(events: BusEvent[]) {
    published.push(...events);
    return { accepted: events.length, duplicates: 0 };
  },
} as unknown as EventBus;
// A segment change publishes events; it never writes ClickHouse.
const events = { async insertMessageEvents() {} } as unknown as EventStore;

const segmentEvent = (over: Partial<BusEvent> = {}): BusEvent => {
  const now = new Date().toISOString();
  return {
    workspaceId: d.workspace,
    sourceId: 'system',
    messageId: 'seg:change:1',
    type: 'track',
    name: 'Segment Entered',
    anonymousId: 'anon_1102',
    userId: 'user_1102',
    timestamp: now,
    receivedAt: now,
    properties: { segment_id: 'seg_1102', segment_name: 'Test list', segment_version: 1, profile_id: 'prf_1102' },
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
    ...over,
  };
};

const dispatch = () => dispatchOutboxOnce({ db: d.db, kp: localKeyProvider(MASTER_KEY), events, bus });

const rowState = async (operationKey: string) => {
  const { rows } = await d.db.admin.query<{ state: string; failure_kind: string | null }>(
    'SELECT state, failure_kind FROM outbox WHERE workspace_id = $1 AND operation_key = $2',
    [d.workspace, operationKey],
  );
  return rows[0];
};

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('segment_change_outbox');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

beforeEach(async () => {
  published.length = 0;
  if (d) await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1', [d.workspace]);
});

describe.skipIf(!hasTestDatabase())('the segment_change outbox payload (#1102)', () => {
  it('publishes a complete payload', async () => {
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueOutbox(tx, d.workspace, {
        kind: 'segment_change',
        operationKey: 'valid-change',
        payload: { events: [segmentEvent()] },
      }),
    );
    const result = await dispatch();
    expect(result).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ name: 'Segment Entered', workspaceId: d.workspace });
    expect(await rowState('valid-change')).toMatchObject({ state: 'delivered' });
  });

  it('fails a payload whose event is missing fields permanently, without publishing it', async () => {
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueOutbox(tx, d.workspace, {
        kind: 'segment_change',
        operationKey: 'corrupt-change',
        // The old schema checked only the workspace, so this row used to be published as is.
        payload: { events: [{ workspaceId: d.workspace, name: 'Segment Entered' }] },
      }),
    );
    const result = await dispatch();
    expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });
    expect(published).toHaveLength(0);
    const state = await rowState('corrupt-change');
    expect(state).toMatchObject({ state: 'failed', failure_kind: 'permanent' });
    // A permanent failure is not retried on a later round.
    expect((await dispatch()).claimed).toBe(0);
  });

  it('fails an event of an unknown type permanently', async () => {
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueOutbox(tx, d.workspace, {
        kind: 'segment_change',
        operationKey: 'unknown-type',
        payload: { events: [{ ...segmentEvent(), type: 'from-a-newer-release' }] },
      }),
    );
    expect((await dispatch()).failed).toBe(1);
    expect(published).toHaveLength(0);
    expect(await rowState('unknown-type')).toMatchObject({ state: 'failed', failure_kind: 'permanent' });
  });

  it('still refuses a well-formed payload that names another workspace', async () => {
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueOutbox(tx, d.workspace, {
        kind: 'segment_change',
        operationKey: 'other-workspace',
        payload: { events: [segmentEvent({ workspaceId: newId('id') })] },
      }),
    );
    expect((await dispatch()).failed).toBe(1);
    expect(published).toHaveLength(0);
    expect(await rowState('other-workspace')).toMatchObject({ state: 'failed', failure_kind: 'permanent' });
  });
});
