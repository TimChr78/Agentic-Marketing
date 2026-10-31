import { describe, expect, it } from 'vitest';
import { classifyFetchError, consumeLoop, type FetchedMessage, MAX_FETCH_FAILURES, type PullConsumer } from '../src/bus';
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
