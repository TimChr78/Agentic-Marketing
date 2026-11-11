import { randomBytes } from 'node:crypto';
import type { BusEvent, EventBus } from '@agentic-marketing/events';
import { type HotState, valkeyHotState } from '@agentic-marketing/hotstate';
import { localKeyProvider, sealJson } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { inboundTokenHash } from '../src/connections';
import { inboundApi } from '../src/inbound';
import { newWebhookSecret, webhookHeaders } from '../src/signing';

// #643: a signed Standard Webhooks delivery carries a webhook-id, and the receiver must remember
// it for at least the 5-minute timestamp tolerance. Replaying a captured signed request within
// that window must not publish its events again. The seen ids live in the shared hot state, so the
// tests use a real Valkey next to a throwaway Postgres; the bus is a recorder.

const kp = localKeyProvider(Buffer.alloc(32, 7).toString('base64'));
const VALKEY_URL = process.env.VALKEY_URL;
const run = `am-inbound-replay-${process.pid}-${Date.now()}`;
const secret = newWebhookSecret();

type Server = ReturnType<typeof inboundApi>;

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
function app(store: Pick<HotState, 'claim' | 'release'> = hot) {
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
    const down: Pick<HotState, 'claim' | 'release'> = {
      claim: async () => {
        throw new Error('valkey unavailable');
      },
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
