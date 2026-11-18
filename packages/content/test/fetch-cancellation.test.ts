import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbortError } from '@agentic-marketing/core';
import type { Tx } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchSource } from '../src/fetch';

// #1043 review: a stop is not a faulty feed. Cancelling a request used to fall into the retry loop
// and then into `markFailure`, which advances `lastFetchAt` and increments `consecutiveFailures`,
// so a healthy feed waited 2x–16x longer after the restart. A cancellation must not be retried and
// must not be recorded.

let requests = 0;
const server = createServer(() => {
  // Headers and body never arrive: only the abort can end this request.
  requests++;
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A transaction that records every write instead of performing it. */
function recordingTx() {
  const stored: Record<string, unknown>[] = [];
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          stored.push(values);
        },
      }),
    }),
  } as unknown as Tx;
  return { tx, stored };
}

const source = (id: string) =>
  ({
    id: `csrc_${id.repeat(32)}`,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    url: `${base}/feed`,
    kind: 'rss',
    enabled: true,
    etag: null,
    lastModified: null,
    lastFetchAt: null,
    consecutiveFailures: 0,
    fetchIntervalMinutes: 60,
  }) as never;

describe('a cancelled content fetch (#1043 review)', () => {
  it('is not retried and records no failure', async () => {
    requests = 0;
    const { tx, stored } = recordingTx();
    const stop = new AbortController();
    const fetching = fetchSource(tx, source('a'), {
      egress: { allowedHosts: ['127.0.0.1'] },
      retryDelaysMs: [10, 10],
      signal: stop.signal,
    });
    // Long enough for the first request to be on the wire, short enough that a retry loop would
    // still be inside its backoff when the abort lands.
    setTimeout(() => stop.abort(), 80);
    const err = await fetching.then(
      () => null,
      (e: unknown) => e,
    );
    expect(isAbortError(err)).toBe(true);
    // One request, not one per retry: a shutdown is not a feed to try again.
    expect(requests).toBe(1);
    // Nothing reached `content_sources`: no lastFetchAt, no lastError, no failure count.
    expect(stored).toEqual([]);
  });
});
