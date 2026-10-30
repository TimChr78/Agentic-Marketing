import type { Db, Tx } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore, MessageEvent } from '@agentic-marketing/events';
import { describe, expect, it } from 'vitest';
import { EMAIL_EVENTS, withEmailProfileEvents, withResolvedEventProfiles } from '../src/messageEvents';

// The e-mail message log becomes customer events in code, so the mapping and the identifier
// lookups can be unit-tested with a recording store, bus and database handle.

const emptyTx = (): Tx =>
  ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => [] }),
      }),
    }),
  }) as unknown as Tx;

function fakeDb(identifierRows: (params: unknown[]) => unknown[] = () => []): Db {
  return {
    admin: {
      query: async (_sql: string, params: unknown[]) => ({ rows: identifierRows(params) }),
    },
    withWorkspace: async (_ws: string, cb: (tx: Tx) => Promise<unknown>) => cb(emptyTx()),
  } as unknown as Db;
}

function recordingStore() {
  const inserted: MessageEvent[][] = [];
  const store = {
    insert: async (events: BusEvent[]) => {
      inserted.push(events as never);
    },
    insertMessageEvents: async (events: MessageEvent[]) => {
      inserted.push(events);
    },
  } as unknown as EventStore;
  return { store, inserted };
}

function recordingBus() {
  const published: BusEvent[] = [];
  const bus = {
    publish: async (events: BusEvent[]) => {
      published.push(...events);
      return { accepted: events.length, duplicates: 0 };
    },
  } as unknown as EventBus;
  return { bus, published };
}

const busEvent = (overrides: Partial<BusEvent> = {}): BusEvent => ({
  workspaceId: 'ws_01',
  sourceId: 'src_01',
  messageId: 'msg_1',
  type: 'track',
  name: 'Order Completed',
  anonymousId: '',
  userId: '',
  timestamp: '2026-10-01T10:00:00.000Z',
  receivedAt: '2026-10-01T10:00:01.000Z',
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
  ...overrides,
});

const messageEvent = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  workspaceId: 'ws_01',
  messageId: 'msg_1',
  eventId: 'evt_1',
  type: 'clicked',
  at: '2026-10-01T10:00:00.000Z',
  profileId: 'prf_1',
  channel: 'email',
  purpose: 'marketing_email',
  provider: 'ses',
  templateId: 'eml_x',
  templateVersion: 2,
  journeyId: 'bct_y',
  reason: '',
  url: 'https://shop.example.com/x',
  ...overrides,
});

describe('message event mapping', () => {
  it('names each delivery event as the customer event people can segment on', () => {
    expect(EMAIL_EVENTS).toEqual({
      sent: 'Email Sent',
      delivered: 'Email Delivered',
      bounced: 'Email Bounced',
      complained: 'Email Complained',
      clicked: 'Email Link Clicked',
      unsubscribed: 'Email Unsubscribed',
    });
    expect(EMAIL_EVENTS.clicked).toBe('Email Link Clicked');
  });

  it('leaves internal message states unmapped', () => {
    for (const type of ['queued', 'suppressed', 'failed', 'deferred', 'opened'] as const) expect(EMAIL_EVENTS[type]).toBeUndefined();
  });
});

describe('profile resolution for raw events', () => {
  it('resolves user and anonymous identifiers in one lookup per workspace', async () => {
    const queries: unknown[][] = [];
    const db = fakeDb((params) => {
      queries.push(params);
      return [
        { type: 'user_id', value: 'usr_1', profile_id: 'prf_user' },
        { type: 'anonymous_id', value: 'anon_1', profile_id: 'prf_anon' },
      ];
    });
    const { store, inserted } = recordingStore();
    const wrapped = withResolvedEventProfiles(store, db);

    await wrapped.insert([
      busEvent({ userId: 'usr_1' }),
      busEvent({ messageId: 'msg_2', anonymousId: 'anon_1' }),
      busEvent({ messageId: 'msg_3', userId: 'usr_unknown' }),
      busEvent({ messageId: 'msg_4', profileId: 'prf_known', userId: 'usr_1' }),
    ]);

    expect(queries).toEqual([['ws_01', ['usr_1', 'usr_unknown'], ['anon_1']]]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.map((e) => e.profileId)).toEqual(['prf_user', 'prf_anon', undefined, 'prf_known']);
    expect(inserted[0]?.[0]).toMatchObject({ messageId: 'msg_1', userId: 'usr_1', profileId: 'prf_user' });
  });

  it('does not query when every event already carries a profile id', async () => {
    let queries = 0;
    const db = fakeDb(() => {
      queries++;
      return [];
    });
    const { store, inserted } = recordingStore();
    await withResolvedEventProfiles(store, db).insert([busEvent({ profileId: 'prf_1' })]);
    expect(queries).toBe(0);
    expect(inserted[0]?.[0]?.profileId).toBe('prf_1');
  });

  it('looks up each workspace separately and matches ids by workspace, never across tenants', async () => {
    const queries: unknown[][] = [];
    const db = fakeDb((params) => {
      queries.push(params);
      return params[0] === 'ws_a' ? [{ type: 'user_id', value: 'usr_1', profile_id: 'prf_a' }] : [];
    });
    const { store, inserted } = recordingStore();

    await withResolvedEventProfiles(store, db).insert([
      busEvent({ workspaceId: 'ws_a', userId: 'usr_1' }),
      busEvent({ workspaceId: 'ws_b', userId: 'usr_1' }),
    ]);

    expect(queries).toEqual([
      ['ws_a', ['usr_1'], []],
      ['ws_b', ['usr_1'], []],
    ]);
    expect(inserted[0]?.map((e) => e.profileId)).toEqual(['prf_a', undefined]);
  });

  it('leaves an unknown person unresolved instead of guessing', async () => {
    const { store, inserted } = recordingStore();
    await withResolvedEventProfiles(store, fakeDb()).insert([busEvent({ userId: 'usr_unknown' })]);
    expect(inserted[0]?.[0]?.profileId).toBeUndefined();
  });

  it('passes an empty batch straight through and keeps the rest of the store intact', async () => {
    const { store, inserted } = recordingStore();
    const wrapped = withResolvedEventProfiles(store, fakeDb());
    await wrapped.insert([]);
    expect(inserted).toEqual([[]]);
    expect(wrapped.insertMessageEvents).toBe(store.insertMessageEvents);
  });
});

describe('e-mail message events as customer events', () => {
  it('publishes a click as "Email Link Clicked" with the message, template and link', async () => {
    const { store, inserted } = recordingStore();
    const { bus, published } = recordingBus();
    const wrapped = withEmailProfileEvents(store, {
      db: fakeDb(() => [{ profile_id: 'prf_1', type: 'user_id', value: 'usr_1' }]),
      bus,
    });

    await wrapped.insertMessageEvents([messageEvent()]);
    expect(inserted).toHaveLength(1);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'track',
      name: 'Email Link Clicked',
      sourceId: 'email',
      userId: 'usr_1',
      messageId: 'email:msg_1:evt_1',
      timestamp: '2026-10-01T10:00:00.000Z',
    });
    expect(published[0]?.properties).toEqual({
      message_id: 'msg_1',
      template_id: 'eml_x',
      campaign_id: 'bct_y',
      purpose: 'marketing_email',
      url: 'https://shop.example.com/x',
    });
  });

  it('maps delivered, bounced, complained and unsubscribed, and appends the missing Z', async () => {
    const { store } = recordingStore();
    const { bus, published } = recordingBus();
    const wrapped = withEmailProfileEvents(store, {
      db: fakeDb(() => [{ profile_id: 'prf_1', type: 'user_id', value: 'usr_1' }]),
      bus,
    });

    await wrapped.insertMessageEvents([
      messageEvent({ eventId: 'evt_2', type: 'delivered', at: '2026-10-01T10:01:00.000', url: '', reason: '' }),
      messageEvent({ eventId: 'evt_3', type: 'bounced', reason: 'mailbox_full', url: '' }),
      messageEvent({ eventId: 'evt_4', type: 'complained', url: '' }),
      messageEvent({ eventId: 'evt_5', type: 'unsubscribed', url: '' }),
    ]);

    expect(published.map((e) => e.name)).toEqual(['Email Delivered', 'Email Bounced', 'Email Complained', 'Email Unsubscribed']);
    expect(published[0]?.timestamp).toBe('2026-10-01T10:01:00.000Z');
    expect(published[0]?.properties).not.toHaveProperty('url');
    expect(published[1]?.properties).toMatchObject({ reason: 'mailbox_full' });
  });

  it('does not publish internal states, events without a person, or people with no identifier row', async () => {
    const { store } = recordingStore();
    const { bus, published } = recordingBus();
    const wrapped = withEmailProfileEvents(store, { db: fakeDb(), bus });

    await wrapped.insertMessageEvents([
      messageEvent({ type: 'opened' }),
      messageEvent({ eventId: 'evt_2', profileId: '' }),
      messageEvent({ eventId: 'evt_3' }),
      messageEvent({ eventId: 'evt_4', type: 'sent' }),
    ]);
    expect(published).toEqual([]);
  });

  it('uses the identifier row the distinct-on lookup returns, preferring a user id in SQL', async () => {
    const { store } = recordingStore();
    const { bus, published } = recordingBus();
    const wrapped = withEmailProfileEvents(store, {
      // The lookup is DISTINCT ON (profile_id) ORDER BY (type = 'user_id') DESC, last_seen DESC,
      // so the database returns one row per person: their user id when they have one.
      db: fakeDb(() => [
        { profile_id: 'prf_1', type: 'user_id', value: 'usr_1' },
        { profile_id: 'prf_2', type: 'anonymous_id', value: 'anon_2' },
      ]),
      bus,
    });

    await wrapped.insertMessageEvents([messageEvent(), messageEvent({ eventId: 'evt_2', profileId: 'prf_2' })]);
    expect(published[0]).toMatchObject({ userId: 'usr_1', anonymousId: '' });
    expect(published[1]).toMatchObject({ userId: '', anonymousId: 'anon_2' });
  });

  it('keeps the message log even when publishing customer events fails', async () => {
    const { store, inserted } = recordingStore();
    const bus = {
      publish: async () => {
        throw new Error('bus down');
      },
    } as unknown as EventBus;
    const wrapped = withEmailProfileEvents(store, { db: fakeDb(), bus });

    await expect(wrapped.insertMessageEvents([messageEvent()])).resolves.toBeUndefined();
    expect(inserted).toHaveLength(1);
  });
});
