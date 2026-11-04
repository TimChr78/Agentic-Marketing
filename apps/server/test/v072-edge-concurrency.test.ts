import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { syncEdge } from '@agentic-marketing/personalize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let t: Awaited<ReturnType<typeof startTestServer>>;
let cf: Server;
let apiBase: string;
let owner: User;
let ws: string;
let pause: { path: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
const stores = new Map<string, Map<string, unknown>>();
const store = (ns: string) => {
  if (!stores.has(ns)) stores.set(ns, new Map());
  return stores.get(ns)!;
};
const row = async () => (await t.srv.db.admin.query('SELECT * FROM edge_targets WHERE workspace_id = $1', [ws])).rows[0];
const run = () => syncEdge({ db: t.srv.db, hot: t.srv.hot, kp: t.srv.keyProvider, egress: t.srv.egress }, ws);
const configure = (namespaceId: string, extra: Record<string, unknown> = {}) =>
  t.api(owner).call('edge.configure', { accountId: A, namespaceId, apiBase, ...extra });

beforeAll(async () => {
  cf = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '[]');
    const url = new URL(req.url!, 'http://localhost');
    const match = url.pathname.match(/namespaces\/([^/]+)(\/.*)$/)!;
    const kv = store(match[1]);
    const gate = pause;
    if (gate && match[2] === gate.path) {
      pause = undefined;
      gate.entered.resolve();
      await gate.release.promise;
    }
    let result: unknown[] = [];
    if (match[2] === '/bulk' && req.method === 'PUT') {
      for (const entry of body) kv.set(entry.key, JSON.parse(entry.value));
    } else if (match[2] === '/bulk/delete') {
      for (const key of body) kv.delete(key);
    } else if (match[2] === '/keys') {
      result = [...kv.keys()].filter((key) => key.startsWith(url.searchParams.get('prefix') ?? '')).map((name) => ({ name }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, errors: [], result }));
  });
  await new Promise<void>((r) => cf.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(cf.address() as AddressInfo).port}`;
  t = await startTestServer('test_v072_edge_races', testPort(3489), {}, { edgeTickMs: 86_400_000 });
  owner = await t.signUp(`edge-races-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
}, 60_000);
afterAll(async () => {
  await t?.close();
  cf?.close();
});

describe('edge configuration during an in-flight sync', () => {
  it('retains a new cleanup and backfill when an old cleanup finishes', async () => {
    await configure(B, { apiToken: 'test-token-'.repeat(4) });
    await run();
    await configure(B, { snapshots: false });
    const gate = { path: '/keys', entered: deferred(), release: deferred() };
    pause = gate;
    const oldTick = run();
    try {
      await gate.entered.promise;
      await configure(C, { snapshots: true });
      const before = await row();
      // A second scheduler cannot overtake the first while it has a remote write in flight.
      await run();
      expect(await row()).toMatchObject({ generation: before.generation, cleanup_mode: 'all', backfill_cursor: '' });
      gate.release.resolve();
      await oldTick;
      expect(await row()).toMatchObject({
        generation: before.generation,
        cleanup_mode: 'all',
        backfill_cursor: '',
        prior_target: before.prior_target,
      });
      await run();
      expect(store(B).size).toBe(0);
      expect(await row()).toMatchObject({ cleanup_mode: null, backfill_cursor: null, prior_target: null });
    } finally {
      gate.release.resolve();
      await oldTick;
    }
  });

  it('tracks late bundle keys and retains outbox work delivered to an old namespace', async () => {
    await t.api(owner).call('sources.create', { name: 'Concurrent source', kind: 'browser', allowedOrigins: ['https://example.com'] });
    const gate = { path: '/bulk', entered: deferred(), release: deferred() };
    pause = gate;
    const oldTick = run();
    try {
      await gate.entered.promise;
      await configure(B);
      const changed = await row();
      expect(changed.prior_target[0].keys.some((key: string) => key.startsWith('am:key:'))).toBe(true);
      gate.release.resolve();
      await oldTick;
      expect(await row()).toMatchObject({ generation: changed.generation, bundle_hash: null, cleanup_mode: 'all', backfill_cursor: '' });
      await run();
      expect(store(C).size).toBe(0);
    } finally {
      gate.release.resolve();
      await oldTick;
    }

    const key = `am:snap:${ws}:u:concurrent`;
    await t.srv.db.admin.query('INSERT INTO edge_outbox (workspace_id, key, value) VALUES ($1, $2, $3)', [
      ws,
      key,
      JSON.stringify({ marker: 'latest' }),
    ]);
    const outboxGate = { path: '/bulk', entered: deferred(), release: deferred() };
    pause = outboxGate;
    const outboxTick = run();
    try {
      await outboxGate.entered.promise;
      await configure(C);
      outboxGate.release.resolve();
      await outboxTick;
      expect((await t.srv.db.admin.query('SELECT key FROM edge_outbox WHERE workspace_id = $1', [ws])).rows).toContainEqual({ key });
      await run();
      expect(store(B).size).toBe(0);
      expect(store(C).get(key)).toEqual({ marker: 'latest' });
      expect((await t.srv.db.admin.query('SELECT key FROM edge_outbox WHERE workspace_id = $1', [ws])).rows).toEqual([]);
    } finally {
      outboxGate.release.resolve();
      await outboxTick;
    }
  });

  it('does not leave an impossible backfill pending while snapshots are disabled', async () => {
    await configure(C, { snapshots: false });
    await t.api(owner).call('edge.sync', { backfillSnapshots: true });
    expect((await row()).backfill_cursor).toBeNull();
  });
});
