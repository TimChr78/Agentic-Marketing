import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tx } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchSource } from '../src/fetch';

// #885 round 6: a content source's failure is stored in `content_sources.last_error` and returned in
// the sweep's summary. A feed body can echo a credential (GitHub's error page, a token in a URL or
// an element name), so the text is redacted while it is complete, then cut.

let body = '';
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/rss+xml' });
  res.end(body);
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A transaction that records the failure row instead of writing it. */
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

describe('content fetch failure text (#885)', () => {
  it('redacts a credential the response echoes before storing it', async () => {
    body = '<ghp_abcdef0123456789/>';
    const { tx, stored } = recordingTx();
    const source = {
      id: `csrc_${'0'.repeat(32)}`,
      workspaceId: '00000000-0000-4000-8000-000000000001',
      url: `${base}/feed`,
      kind: 'rss',
      enabled: true,
      etag: null,
      lastModified: null,
      lastFetchAt: null,
      consecutiveFailures: 0,
      fetchIntervalMinutes: 60,
    };
    const result = await fetchSource(tx, source as never, { egress: { allowedHosts: ['127.0.0.1'] }, retryDelaysMs: [] });

    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('ghp_abcdef0123456789');
    expect(String(stored[0]?.lastError)).not.toContain('ghp_abcdef0123456789');
    expect(stored[0]).toHaveProperty('lastError');
  });

  it('keeps the parse failure useful', async () => {
    body = '<not-a-feed/>';
    const { tx } = recordingTx();
    const source = {
      id: `csrc_${'1'.repeat(32)}`,
      workspaceId: '00000000-0000-4000-8000-000000000001',
      url: `${base}/feed`,
      kind: 'rss',
      enabled: true,
      etag: null,
      lastModified: null,
      lastFetchAt: null,
      consecutiveFailures: 0,
      fetchIntervalMinutes: 60,
    };
    const result = await fetchSource(tx, source as never, { egress: { allowedHosts: ['127.0.0.1'] }, retryDelaysMs: [] });
    expect(result.error).toContain('not an RSS or Atom feed');
  });
});
