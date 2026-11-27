import { logger } from '@agentic-marketing/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { type BusEvent, type EventBus, type EventStore, runSink } from '../src';

// The sink reads every event of a batch to hash its subject keys. A record whose own fields are
// the wrong shape cannot become readable by another delivery, so it is dropped and logged with
// correlation metadata only; the rest of the batch is still stored. A read of a dependency (the
// erasure filter, a key, ClickHouse) still fails the batch so it is retried.

const ws = '00000000-0000-4000-8000-000000000001';

const event = (id: string, over: Partial<BusEvent> = {}): BusEvent => ({
  workspaceId: ws,
  sourceId: 'src_sink_drops',
  messageId: id,
  type: 'track',
  name: 'Sink Drops',
  anonymousId: `${id}-anon`,
  userId: '',
  timestamp: '2026-11-02T12:00:00.000Z',
  receivedAt: '2026-11-02T12:00:00.000Z',
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...over,
});

const bus = (batches: BusEvent[][]): EventBus => ({
  async consume(_opts, handler) {
    for (const events of batches) await handler(events);
  },
  async publish() {
    return { accepted: 0, duplicates: 0 };
  },
  async close() {},
});

const storeOf = (stored: (events: BusEvent[]) => number = (events) => events.length) => {
  const inserted: BusEvent[][] = [];
  const store = {
    insert: async (events: BusEvent[]) => {
      inserted.push(events);
      return stored(events);
    },
  } as unknown as EventStore;
  return { store, inserted };
};

describe('sink batch drops', () => {
  it('drops a record whose own fields are unreadable and logs only correlating metadata', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation((() => {}) as never);
    const debug = vi.spyOn(logger, 'debug').mockImplementation((() => {}) as never);
    try {
      const good = event('good');
      // An older or corrupt queued record: the store cannot write its timestamps.
      const older = { ...event('older'), receivedAt: null } as unknown as BusEvent;
      const { store, inserted } = storeOf();

      await runSink(bus([[older, good]]), store, new AbortController().signal);

      expect(inserted).toEqual([[good]]);
      expect(error).toHaveBeenCalledTimes(1);
      const [fields, message] = error.mock.calls[0]!;
      expect(fields).toEqual({ workspaceId: ws, eventId: 'older', field: 'receivedAt' });
      expect(String(message)).toContain('event dropped from the sink batch');
      expect(debug).toHaveBeenCalledWith({ events: 2, stored: 1, dropped: 1 }, expect.any(String));
    } finally {
      error.mockRestore();
      debug.mockRestore();
    }
  });

  it('drops a record that lost a required map instead of passing it to the filter', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation((() => {}) as never);
    try {
      const older = { ...event('no-traits') } as Record<string, unknown>;
      delete older.piiTraits;
      const seen: BusEvent[][] = [];
      const { store } = storeOf();

      await runSink(bus([[older as unknown as BusEvent, event('kept')]]), store, new AbortController().signal, {
        filter: async (events) => {
          seen.push(events);
          return events;
        },
      });

      // The filter never sees the unreadable record, so a missing map cannot fail its read.
      expect(seen).toEqual([[expect.objectContaining({ messageId: 'kept' })]]);
      expect(error.mock.calls[0]?.[0]).toEqual({ workspaceId: ws, eventId: 'no-traits', field: 'piiTraits' });
    } finally {
      error.mockRestore();
    }
  });

  it('fails the batch when the filter cannot reach its dependency', async () => {
    const { store } = storeOf();
    await expect(
      runSink(bus([[event('a')]]), store, new AbortController().signal, {
        filter: async () => {
          throw new Error('database unavailable');
        },
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('reports what the store wrote, not how many events it received', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation((() => {}) as never);
    try {
      // The store may drop a record of its own (a value its own row writer cannot read), and the
      // sink's count must say so instead of counting the whole batch as stored.
      const { store } = storeOf(() => 0);
      await runSink(bus([[event('unwritable')]]), store, new AbortController().signal);
      expect(debug).toHaveBeenCalledWith({ events: 1, stored: 0, dropped: 1 }, expect.any(String));
    } finally {
      debug.mockRestore();
    }
  });
});
