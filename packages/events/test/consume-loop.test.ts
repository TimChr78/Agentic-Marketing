import { describe, expect, it } from 'vitest';
import {
  classifyFetchError,
  consumeLoop,
  consumerPhases,
  type FetchedMessage,
  MAX_FETCH_FAILURES,
  type MessageBatch,
  type PullConsumer,
} from '../src/bus';
import type { BusEvent } from '../src/schema';

// The consume loop keeps a worker alive through transient pull errors, recreates a missing
// consumer, and stops (so the process restarts) on fatal or persistent errors (#307).

const msg = (n: number): FetchedMessage => ({ data: new TextEncoder().encode(String(n)), ack: () => {}, nak: () => {} });
const decode = (d: Uint8Array) => ({ n: Number(new TextDecoder().decode(d)) }) as unknown as BusEvent;
const batch = (items: FetchedMessage[]) =>
  (async function* () {
    yield* items;
  })();
const opts = { name: 'test', maxBatch: 10, maxWaitMs: 0 };

/** A consumer whose fetches follow a script: an error to throw, or messages to return. */
function scripted(steps: (Error | FetchedMessage[])[], onEmpty: () => void) {
  let i = 0;
  const consumer: PullConsumer = {
    fetch: async () => {
      const step = steps[i++];
      if (step === undefined) {
        onEmpty();
        return batch([]);
      }
      if (step instanceof Error) throw step;
      return batch(step);
    },
  };
  return consumer;
}

/**
 * A fetched batch that yields nothing until it is stopped, the way the pinned client's iterator
 * waits for a pull that a reconnect never answers. `stop()` releases the pending `next()` and ends
 * the iteration, which is what the real queued iterator does.
 */
function quietBatch() {
  let release: () => void = () => {};
  const stoppedIteration = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { stopped: 0 };
  const iterable: MessageBatch = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await stoppedIteration;
        return { done: true as const, value: undefined };
      },
    }),
    stop: () => {
      state.stopped += 1;
      release();
    },
  };
  return {
    iterable,
    get stopped() {
      return state.stopped;
    },
  };
}

describe('classifyFetchError (#307)', () => {
  it('retries heartbeats and timeouts, recreates a missing consumer, and stops on authorization errors', () => {
    expect(classifyFetchError(new Error('heartbeats missed'))).toBe('transient');
    expect(classifyFetchError(new Error('TIMEOUT'))).toBe('transient');
    expect(classifyFetchError(Object.assign(new Error('consumer not found'), { api_error: { err_code: 10014 } }))).toBe('missing_consumer');
    expect(classifyFetchError(new Error('Authorization Violation'))).toBe('fatal');
    expect(classifyFetchError(new Error('Permissions Violation for Subscription'))).toBe('fatal');
  });
});

describe('consumeLoop (#307)', () => {
  it('keeps consuming after a transient error', async () => {
    const stop = new AbortController();
    const seen: number[] = [];
    const consumer = scripted([new Error('heartbeats missed'), [msg(1), msg(2)]], () => stop.abort());
    await consumeLoop(
      async () => consumer,
      opts,
      decode,
      async (events) => {
        seen.push(...events.map((e) => (e as unknown as { n: number }).n));
      },
      stop.signal,
      { retryMs: 1 },
    );
    expect(seen).toEqual([1, 2]);
  });

  it('creates the consumer again when it no longer exists', async () => {
    const stop = new AbortController();
    let created = 0;
    const seen: number[] = [];
    const consumer = scripted([new Error('consumer not found'), [msg(3)]], () => stop.abort());
    await consumeLoop(
      async () => {
        created++;
        return consumer;
      },
      opts,
      decode,
      async (events) => {
        seen.push(...events.map((e) => (e as unknown as { n: number }).n));
      },
      stop.signal,
      { retryMs: 1 },
    );
    expect(created).toBe(2);
    expect(seen).toEqual([3]);
  });

  it('rejects on a fatal error instead of retrying', async () => {
    const consumer = scripted([new Error('Authorization Violation')], () => {});
    await expect(
      consumeLoop(
        async () => consumer,
        opts,
        decode,
        async () => {},
        new AbortController().signal,
        { retryMs: 1 },
      ),
    ).rejects.toThrow('Authorization Violation');
  });

  it('stops while a pull is still waiting for a connection that is reconnecting', async () => {
    // A fetch that never settles is what a reconnect leaves behind; the abort must not wait for it.
    const consumer: PullConsumer = { fetch: () => new Promise<MessageBatch>(() => {}) };
    const stop = new AbortController();
    const started = Date.now();
    const loop = consumeLoop(
      async () => consumer,
      opts,
      decode,
      async () => {},
      stop.signal,
      { retryMs: 1 },
    );
    // Let the loop reach its fetch, then close the way a shutdown does.
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops a fetched batch that is still waiting for messages, and leaves them unacked', async () => {
    // The pinned client's fetch() returns its iterator immediately and waits inside it; on a
    // reconnect that wait is not bounded, so only stopping the batch ends it (#1028 review).
    const batch = quietBatch();
    const consumer: PullConsumer = { fetch: async () => batch.iterable };
    const stop = new AbortController();
    const started = Date.now();
    const loop = consumeLoop(
      async () => consumer,
      { ...opts, maxWaitMs: 60_000 },
      decode,
      async () => {
        throw new Error('an aborted batch must not reach the handler');
      },
      stop.signal,
      { retryMs: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(batch.stopped).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops while it is backing off after a failed pull', async () => {
    const consumer: PullConsumer = {
      fetch: async () => {
        throw new Error('heartbeats missed');
      },
    };
    const stop = new AbortController();
    const started = Date.now();
    const loop = consumeLoop(
      async () => consumer,
      opts,
      decode,
      async () => {},
      stop.signal,
      { retryMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops while it is still creating its consumer', async () => {
    // The consumer setup is a NATS API call; on a reconnecting connection it may not complete.
    const stop = new AbortController();
    const started = Date.now();
    const loop = consumeLoop(
      () => new Promise<PullConsumer>(() => {}),
      opts,
      decode,
      async () => {},
      stop.signal,
      { retryMs: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports the phase it is in, so a shutdown can say what it waits on', async () => {
    const batch = quietBatch();
    const consumer: PullConsumer = { fetch: async () => batch.iterable };
    const stop = new AbortController();
    const loop = consumeLoop(
      async () => consumer,
      { ...opts, maxWaitMs: 60_000 },
      decode,
      async () => {},
      stop.signal,
      { retryMs: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(consumerPhases().find((p) => p.name === 'test')?.phase).toBe('waiting');
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(consumerPhases().find((p) => p.name === 'test')?.phase).toBe('stopped');
  });

  it('rejects after too many failures in a row, so the worker restarts', async () => {
    const consumer = scripted(
      Array.from({ length: MAX_FETCH_FAILURES }, () => new Error('stream reset')),
      () => {},
    );
    await expect(
      consumeLoop(
        async () => consumer,
        opts,
        decode,
        async () => {},
        new AbortController().signal,
        { retryMs: 1 },
      ),
    ).rejects.toThrow('stream reset');
  });
});
