import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HotState } from '@agentic-marketing/hotstate';
import { syncEdge } from '@agentic-marketing/personalize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failFakeServer } from '../../../test-support/index';
import { startTestServer, testPort, type User } from './harness';

// #1203 review: the edge outbox sync must acknowledge exactly the rows it processed, and a Valkey
// outage must not hold back an erasure delete.

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
const kv = new Map<string, unknown>();
const NAMESPACE = 'e'.repeat(32);
const snapKey = (id: string) => `am:snap:${ws}:a:${id}`;
const deps = (hot: HotState = t.srv.hot) => ({ db: t.srv.db, hot, kp: t.srv.keyProvider, egress: t.srv.egress });
const outboxKeys = async () =>
  (await t.srv.db.admin.query<{ key: string }>('SELECT key FROM edge_outbox WHERE workspace_id = $1 ORDER BY id', [ws])).rows.map(
    (r) => r.key,
  );
const queue = (key: string, value: unknown) =>
  t.srv.db.admin.query('INSERT INTO edge_outbox (workspace_id, key, value) VALUES ($1, $2, $3)', [
    ws,
    key,
    value === null ? null : JSON.stringify(value),
  ]);

beforeAll(async () => {
  cf = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '[]');
      const url = new URL(req.url!, 'http://localhost');
      const match = url.pathname.match(/namespaces\/([^/]+)(\/.*)$/)!;
      const gate = pause;
      if (gate && match[2] === gate.path) {
        pause = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      let result: unknown[] = [];
      if (match[2] === '/bulk' && req.method === 'PUT') for (const entry of body) kv.set(entry.key, JSON.parse(entry.value));
      else if (match[2] === '/bulk/delete') for (const key of body) kv.delete(key);
      else if (match[2] === '/keys')
        result = [...kv.keys()].filter((key) => key.startsWith(url.searchParams.get('prefix') ?? '')).map((name) => ({ name }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, errors: [], result }));
    } catch {
      failFakeServer(res, { success: false, errors: [{ code: 500, message: 'fake KV failed' }] });
    }
  });
  await new Promise<void>((r) => cf.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(cf.address() as AddressInfo).port}`;
  t = await startTestServer('test_v0177_edge_outbox_ack', testPort(3601), {}, { edgeTickMs: 86_400_000 });
  owner = await t.signUp(`edge-ack-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await t.api(owner).call('edge.configure', {
    accountId: 'a'.repeat(32),
    namespaceId: NAMESPACE,
    apiBase,
    apiToken: 'test-token-'.repeat(4),
    snapshots: true,
  });
  // Settle the bundle and the backfill so later syncs only drain the outbox.
  for (let i = 0; i < 3; i++) await syncEdge(deps(), ws);
  await t.srv.db.admin.query('DELETE FROM edge_outbox WHERE workspace_id = $1', [ws]);
}, 60_000);
afterAll(async () => {
  await t?.close();
  cf?.close();
});

describe('edge outbox acknowledgement (#1203)', () => {
  it('keeps an erasure delete that commits with a lower id while a sync is uploading', async () => {
    kv.set(snapKey('late-erased'), { stale: true });
    const late = await t.srv.db.admin.connect();
    try {
      // The delete takes its id first but commits only after the sync has read the outbox.
      await late.query('BEGIN');
      await late.query('INSERT INTO edge_outbox (workspace_id, key, value) VALUES ($1, $2, NULL)', [ws, snapKey('late-erased')]);
      await queue(snapKey('live-visitor'), { traits: {}, segments: [] });
      const gate = { path: '/bulk', entered: deferred(), release: deferred() };
      pause = gate;
      const tick = syncEdge(deps(), ws);
      await gate.entered.promise;
      await late.query('COMMIT');
      gate.release.resolve();
      await tick;
    } finally {
      late.release();
    }
    // The sync never saw the delete, so it must still be queued, not acknowledged with the put.
    expect(await outboxKeys()).toEqual([snapKey('late-erased')]);
    expect(kv.has(snapKey('late-erased'))).toBe(true);
    await syncEdge(deps(), ws);
    expect(await outboxKeys()).toEqual([]);
    expect(kv.has(snapKey('late-erased'))).toBe(false);
  });

  it('sends erasure deletes while Valkey is unavailable and keeps the unverified puts queued', async () => {
    kv.set(snapKey('erased-during-outage'), { stale: true });
    await queue(snapKey('erased-during-outage'), null);
    await queue(snapKey('unverified-put'), { traits: {}, segments: [] });
    const down = Object.create(t.srv.hot) as HotState;
    down.tombstonedIds = async () => {
      throw new Error('Valkey unavailable');
    };
    await syncEdge(deps(down), ws);
    expect(kv.has(snapKey('erased-during-outage'))).toBe(false);
    expect(kv.has(snapKey('unverified-put'))).toBe(false);
    expect(await outboxKeys()).toEqual([snapKey('unverified-put')]);
    // Once Valkey answers again the put is verified and uploaded.
    await syncEdge(deps(), ws);
    expect(await outboxKeys()).toEqual([]);
    expect(kv.has(snapKey('unverified-put'))).toBe(true);
  });
});
