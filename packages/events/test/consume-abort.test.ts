import { afterAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import { type EventBus, natsBus, resetNatsNamespace } from '../src';

// #1028 review: the pinned client's `fetch()` returns its iterator at once and waits for messages
// inside it, so an abort must stop the batch. Only a live connection shows whether the client's
// iterator is really released: the fake in consume-loop.test.ts models it.

const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const NS = runScoped('test_events_abort');

let bus: EventBus | undefined;

afterAll(async () => {
  await bus?.close().catch(() => {});
  await resetNatsNamespace(NATS_URL, NS).catch(() => {});
});

describe('a consumer on a live connection (#1028)', () => {
  it('returns promptly on abort while its pull is waiting for messages', async () => {
    await resetNatsNamespace(NATS_URL, NS);
    bus = await natsBus({ url: NATS_URL, namespace: NS });
    const stop = new AbortController();
    const loop = bus.consume({ name: 'abort-test', maxBatch: 10 }, async () => {}, stop.signal);
    // Nothing is published here, so the pull sits in the client's iterator until the server's
    // expiry (about a second). Abort well before that: a shutdown must not wait for the pull.
    await new Promise((r) => setTimeout(r, 200));
    const aborted = Date.now();
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(Date.now() - aborted).toBeLessThan(500);
  }, 30_000);
});
