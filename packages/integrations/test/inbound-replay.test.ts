import { randomBytes, randomUUID } from 'node:crypto';
import type { BusEvent, EventBus } from '@agentic-marketing/events';
import { type ClaimOutcome, type HotState, valkeyHotState } from '@agentic-marketing/hotstate';
import { localKeyProvider, sealJson } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { inboundTokenHash } from '../src/connections';
import { inboundApi } from '../src/inbound';
import { newWebhookSecret, webhookHeaders } from '../src/signing';

// #643: a signed Standard Webhooks delivery carries a webhook-id, and the receiver must remember
// it for at least the 5-minute timestamp tolerance. Replaying a captured signed request within
// that window must not publish its events again. A delivery is only remembered as done after it
// was published: a claim taken by a request that crashed is a short-lived pending lease, not an
// acknowledgement.
//
// The route tests use a real Valkey next to a throwaway Postgres; the crash and concurrency cases
// use an in-memory store with an injected clock so a lease can expire without sleeping.

const kp = localKeyProvider(Buffer.alloc(32, 7).toString('base64'));
const VALKEY_URL = process.env.VALKEY_URL;
const run = `am-inbound-replay-${process.pid}-${Date.now()}`;
const secret = newWebhookSecret();
const PENDING_S = 5;
const DONE_S = 60;

type Server = ReturnType<typeof inboundApi>;
type ReplayTtl = { pendingSeconds: number; doneSeconds: number };

let t: DisposableDb;
let hot!: ReturnType<typeof valkeyHotState>;

beforeAll(async () => {
  if (!hasTestDatabase() || !VALKEY_URL) return;
  t = await createDisposableDb('inbound_replay');
  hot = valkeyHotState({ url: VALKEY_URL, prefix: run });
}, 120_000);

afterAll(async () => {
  if (hot) await hot.close();
  if (t) await t.close();
});

/** Mirrors the route's key (workspace + endpoint + signed id); one sender cannot block another. */
const replayKey = (workspace: string, connection: string, webhookId: string) => `inbound:${workspace}:${connection}:${webhookId}`;

/**
 * The in-memory twin of the Valkey claim state machine: pending leases and completed ids, both
 * with a TTL, and a token that must match for `complete` and `release`. The clock is injected so
 * expiry is deterministic in tests.
 */
class MemoryReplayStore implements Pick<HotState, 'claim' | 'complete' | 'release'> {
  now = 0;
  private readonly entries = new Map<string, { state: 'pending' | 'done'; token: string; expiresAt: number }>();

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async claim(key: string, ttlSeconds: number): Promise<ClaimOutcome> {
    const entry = this.live(key);
    if (entry) return { state: entry.state };
    const token = randomUUID();
    this.entries.set(key, { state: 'pending', token, expiresAt: this.now + ttlSeconds * 1000 });
    return { state: 'claimed', token };
  }

  async complete(key: string, token: string, ttlSeconds: number) {
    const entry = this.live(key);
    if (entry?.state !== 'pending') return false;
    if (entry.token !== token) return false;
    this.entries.set(key, { state: 'done', token, expiresAt: this.now + ttlSeconds * 1000 });
    return true;
  }

  async release(key: string, token: string) {
    const entry = this.live(key);
    if (entry?.state === 'pending' && entry.token === token) this.entries.delete(key);
  }

  advance(ms: number) {
    this.now += ms;
  }
}

async function addConnection(token: string, signingSecret = secret) {
  const id = `con_${randomBytes(16).toString('hex')}`;
  const sealed = await t.db.withWorkspace(t.workspace, (tx) => sealJson(tx, t.workspace, kp, { signingSecret }));
  await t.db.admin.query(
    `INSERT INTO connections
       (workspace_id, id, connector, name, settings, secrets, secrets_key_id, token_hash, enabled)
     VALUES ($1, $2, 'webhook', 'Incoming webhook', $3, $4, $5, $6, true)`,
    [
      t.workspace,
      id,
      JSON.stringify({ mapping: 'body', signature: { scheme: 'standard-webhooks' } }),
      sealed.blob,
      sealed.keyId,
      inboundTokenHash(token),
    ],
  );
  return id;
}

/** The route with a recording bus; `store` defaults to the shared Valkey hot state. */
function app(
  store: Pick<HotState, 'claim' | 'complete' | 'release'> = hot,
  ttl: ReplayTtl = { pendingSeconds: PENDING_S, doneSeconds: DONE_S },
) {
  const events: BusEvent[] = [];
  const server = inboundApi({
    db: t.db,
    bus: {
      publish: async (items: BusEvent[]) => {
        events.push(...items);
        return { duplicates: 0 };
      },
    } as unknown as EventBus,
    kp,
    hot: store,
    replayTtl: ttl,
  });
  return { server, events };
}

const deliver = (server: Server, connection: string, token: string, id: string, body: string) =>
  server.request(`http://localhost/hooks/in/${connection}/${token}`, {
    method: 'POST',
    headers: webhookHeaders(secret, id, body),
    body,
  });

const one = JSON.stringify({ type: 'track', event: 'Order Completed', userId: 'u-1', properties: { value: 10 } });

describe.skipIf(!hasTestDatabase() || !VALKEY_URL)('inbound webhook replay (#643)', () => {
  it('publishes the first signed delivery and nothing for a replay within the window', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token);
    const { server, events } = app();

    const first = await deliver(server, connection, token, 'msg_replay_1', one);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, accepted: 1 });
    expect(events).toHaveLength(1);

    const replay = await deliver(server, connection, token, 'msg_replay_1', one);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ success: true, duplicate: true, accepted: 0 });
    expect(events).toHaveLength(1);
  });

  it('does not acknowledge a pending claim left by a crashed request, then publishes its retry once', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token);
    const store = new MemoryReplayStore();
    const ttl = { pendingSeconds: PENDING_S, doneSeconds: DONE_S };
    const { server, events } = app(store, ttl);

    // A request claimed and died before publishing: the key stays pending until its lease ends.
    const crashed = await store.claim(replayKey(t.workspace, connection, 'msg_crash'), ttl.pendingSeconds);
    expect(crashed.state).toBe('claimed');

    const blocked = await deliver(server, connection, token, 'msg_crash', one);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ error: 'in_progress' });
    expect(events).toHaveLength(0);

    store.advance(ttl.pendingSeconds * 1000);
    const retry = await deliver(server, connection, token, 'msg_crash', one);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ success: true, accepted: 1 });
    expect(events).toHaveLength(1);
  });

  it('does not tell a concurrent request “duplicate” while the first is still publishing, even if it fails', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token);
    const store = new MemoryReplayStore();
    const ttl = { pendingSeconds: PENDING_S, doneSeconds: DONE_S };
    const events: BusEvent[] = [];
    let first = true;
    let started!: () => void;
    let unblock!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      unblock = r;
    });
    const calls: BusEvent[][] = [];
    const server = inboundApi({
      db: t.db,
      bus: {
        publish: async (items: BusEvent[]) => {
          calls.push(items);
          if (first) {
            first = false;
            started();
            await gate;
            throw new Error('bus down');
          }
          events.push(...items);
          return { duplicates: 0 };
        },
      } as unknown as EventBus,
      kp,
      hot: store,
      replayTtl: ttl,
    });

    const inFlight = deliver(server, connection, token, 'msg_concurrent', one);
    await startedP;
    const second = await deliver(server, connection, token, 'msg_concurrent', one);
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({ error: 'in_progress' });
    expect(calls).toHaveLength(1);

    unblock();
    expect((await inFlight).status).toBe(500);
    expect(events).toHaveLength(0);

    const retry = await deliver(server, connection, token, 'msg_concurrent', one);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ success: true, accepted: 1 });
    expect(events).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('only completes the claim it still owns', async () => {
    const store = new MemoryReplayStore();
    const first = await store.claim('takeover', PENDING_S);
    expect(first.state).toBe('claimed');
    if (first.state !== 'claimed') return;
    store.advance(PENDING_S * 1000);
    const second = await store.claim('takeover', PENDING_S);
    expect(second.state).toBe('claimed');
    if (second.state !== 'claimed') return;

    // The first owner's lease expired and another request took over: it must not mark the newer
    // claim done, but the newer owner can.
    expect(await store.complete('takeover', first.token, DONE_S)).toBe(false);
    expect(await store.claim('takeover', PENDING_S)).toEqual({ state: 'pending' });
    expect(await store.complete('takeover', second.token, DONE_S)).toBe(true);
    expect(await store.claim('takeover', DONE_S)).toEqual({ state: 'done' });
  });

  it('lets two endpoints use the same webhook-id', async () => {
    const tokenA = randomBytes(18).toString('base64url');
    const tokenB = randomBytes(18).toString('base64url');
    const a = await addConnection(tokenA);
    const b = await addConnection(tokenB);
    const { server, events } = app();

    expect((await deliver(server, a, tokenA, 'msg_shared', one)).status).toBe(200);
    expect((await deliver(server, b, tokenB, 'msg_shared', one)).status).toBe(200);
    expect(events).toHaveLength(2);
  });

  it('fails closed with a retryable 5xx and publishes nothing when the store is down', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token);
    const down: Pick<HotState, 'claim' | 'complete' | 'release'> = {
      claim: async () => {
        throw new Error('valkey unavailable');
      },
      complete: async () => true,
      release: async () => {},
    };
    const { server, events } = app(down);

    const res = await deliver(server, connection, token, 'msg_store_down', one);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'replay_check_unavailable' });
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(events).toHaveLength(0);
  });

  it('still refuses a signed request with no webhook-id', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token);
    const { server, events } = app();

    const res = await server.request(`http://localhost/hooks/in/${connection}/${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,not-a-signature',
      },
      body: one,
    });
    expect(res.status).toBe(401);
    expect(events).toHaveLength(0);
  });

  it('derives the event message ids from the webhook-id, so a lost store key still dedupes downstream', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token);
    const body = JSON.stringify([
      { type: 'track', event: 'First', userId: 'u-1' },
      { type: 'track', event: 'Second', userId: 'u-1' },
    ]);
    const { server, events } = app();

    expect((await deliver(server, connection, token, 'msg_derived', body)).status).toBe(200);
    expect(events).toHaveLength(2);
    // Two records of one delivery get distinct ids (JetStream dedupes per message id).
    expect(events[0].messageId).not.toBe(events[1].messageId);
    const ids = events.map((e) => e.messageId);

    // A fresh store (as after a restart or a flush) no longer remembers the id, so the route
    // accepts the replay; the message ids are identical, which is what the bus dedupes on.
    const fresh = valkeyHotState({ url: VALKEY_URL!, prefix: `${run}-fresh` });
    try {
      const second = app(fresh);
      expect((await deliver(second.server, connection, token, 'msg_derived', body)).status).toBe(200);
      expect(second.events.map((e) => e.messageId)).toEqual(ids);
    } finally {
      await fresh.close();
    }
  });
});
