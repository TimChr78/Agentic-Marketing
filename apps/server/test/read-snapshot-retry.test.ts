import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Read commands run in a repeatable-read snapshot. A read that creates the workspace's data key
// on first use (profiles.find hashes the e-mail with the matching key) used to fail with "could
// not serialize access" when another request created the same key at the same moment: a 500 to
// the caller. The executor now runs such a read again in a fresh snapshot.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_read_retry', testPort(3478));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
}, 60_000);
afterAll(() => t?.close());

describe('reads that race to create a data key', () => {
  it('all succeed on a fresh workspace', async () => {
    for (let round = 0; round < 3; round++) {
      // A new workspace has no data keys yet, so every concurrent read tries to create one.
      const ws = await t.workspaceWith([[owner, 'owner']]);
      const api = t.api(owner, ws);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => api.call('profiles.find', { type: 'email', value: `nobody-${i}@example.com` })),
      );
      expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    }
  });
});
