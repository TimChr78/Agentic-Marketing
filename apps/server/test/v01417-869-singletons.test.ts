import type { ArtifactType } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// #869: one artifact per workspace for the singleton types is a database constraint, not only an
// application check. A bundle with two entries of one type is refused; a concurrent create race
// answers conflict instead of a raw unique violation. The migration test lives in
// packages/artifacts/test/singleton-index.test.ts.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01417_869', testPort(4452));
  owner = await t.signUp(`owner-v01417-869-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const bundleOf = (artifacts: { id: string; type: ArtifactType; name: string; content: unknown }[]) => ({
  format: 'agentic-marketing/artifacts@1' as const,
  artifacts,
});

describe('singleton artifacts stay unique (#869)', () => {
  it('refuses two entries of one singleton type in a bundle', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const bundle = bundleOf([
      { id: `brd_${'a'.repeat(32)}`, type: 'brand', name: 'Brand A', content: { siteName: 'Brand A' } },
      { id: `brd_${'b'.repeat(32)}`, type: 'brand', name: 'Brand B', content: { siteName: 'Brand B' } },
    ]);
    const err = await rejects(api.call('config.import', { bundle, dryRun: false }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toMatch(/only one brand/i);
    const count = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM artifacts WHERE workspace_id = $1 AND type = 'brand'",
      [ws],
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('turns a concurrent create race into a conflict, not a unique violation', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const results = await Promise.allSettled([
      api.call('artifacts.create', { type: 'brand', name: 'Racing brand', content: { siteName: 'First' } }),
      api.call('artifacts.create', { type: 'brand', name: 'Racing brand', content: { siteName: 'Second' } }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as { code: string; message: string };
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/one brand/i);
    const rows = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM artifacts WHERE workspace_id = $1 AND type = 'brand'",
      [ws],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });
});
