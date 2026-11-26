import type { AddressInfo } from 'node:net';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireRestoreSessionLock, acquireRestoreStartupLock } from '../src/ops/restore-reconcile';
import { freshDatabase } from './harness';

// #1222: both restore lock sessions were plain connections with no TCP keepalive and ran no
// statement after `SELECT pg_backend_pid()`. A peer that vanished without a FIN (a fenced failover,
// a lost host, a partition) was therefore never noticed: the server kept serving without the
// interlock and `am restore` was not refused. The sessions now enable keepalive and answer a
// periodic liveness query, whose client-side timeout turns a silent loss into the existing
// lock-loss path.

interface Relay {
  url: string;
  /** Stops forwarding on the current session without closing either socket, like a lost peer. */
  cut: () => void;
  close: () => Promise<void>;
}

async function silentRelay(target: URL): Promise<Relay> {
  const sockets = new Set<Socket>();
  let live: { client: Socket; upstream: Socket } | undefined;
  const server: Server = createServer((client: Socket) => {
    const upstream = connect(Number(target.port), target.hostname);
    live = { client, upstream };
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = new URL(target.toString());
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.toString(),
    cut() {
      // Neither FIN nor RST: the database side simply stops answering while the holder's socket
      // stays open, which is what a partition or a fenced peer looks like to this process.
      if (!live) return;
      live.client.unpipe(live.upstream);
      live.upstream.unpipe(live.client);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function eventually(check: () => string | undefined, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the lock-loss callback did not fire');
}

let databaseUrl = '';
let sessionDatabaseUrl = '';
let slowDatabaseUrl = '';
let relays: Relay[] = [];

beforeAll(async () => {
  // One database per lock kind: a session cut by the relay keeps its shared lock on the server
  // until the socket is closed, and an exclusive lock in the next test would wait for it.
  databaseUrl = (await freshDatabase('restore_lock_liveness')).url.toString();
  sessionDatabaseUrl = (await freshDatabase('restore_lock_session')).url.toString();
  slowDatabaseUrl = (await freshDatabase('restore_lock_slow')).url.toString();
}, 180_000);

afterAll(async () => {
  for (const relay of relays) await relay.close();
  relays = [];
});

describe('restore lock sessions notice a silently lost connection (#1222)', () => {
  it('reports a lost startup lock when the database side stops answering, with no close', async () => {
    const relay = await silentRelay(new URL(databaseUrl));
    relays.push(relay);
    let lostWith: string | undefined;
    const lock = await acquireRestoreStartupLock(relay.url, {
      onLost: (err) => (lostWith = err.message),
      livenessMs: 50,
      livenessTimeoutMs: 300,
      waitMs: 5_000,
    });
    try {
      // A healthy session answers the liveness check without reporting a loss.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(lostWith).toBeUndefined();
      relay.cut();
      await eventually(() => lostWith);
      expect(lostWith).toMatch(/timed out|liveness|query/i);
    } finally {
      await lock.release();
    }
  }, 60_000);

  // #1222 review: a fence write or check runs on the same session as the heartbeat. pg arms a
  // statement's timeout when it is submitted, so a probe queued behind a slow fence query timed out
  // while the session was still healthy and reported a false loss. Probes now share the session's
  // queue and run only when it is idle, and the probe timeout starts when the probe does.
  it('does not report a loss while a slow foreground statement holds the session', async () => {
    let lostWith: string | undefined;
    const lock = await acquireRestoreSessionLock(slowDatabaseUrl, {
      onLost: (err) => (lostWith = err.message),
      livenessMs: 30,
      livenessTimeoutMs: 100,
    });
    try {
      // Longer than both the heartbeat interval and its timeout: under the old code the probe
      // queued behind this statement and timed out while the lock was still held, and the client's
      // query timeout would also have aborted the statement itself.
      await lock.client.query('SELECT pg_sleep(0.5)');
      expect(lostWith).toBeUndefined();
      // Let several heartbeats run once the session is idle again; each answers immediately.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lostWith).toBeUndefined();
    } finally {
      await lock.release();
    }
  }, 60_000);

  it('reports a lost restore session lock the same way', async () => {
    const relay = await silentRelay(new URL(sessionDatabaseUrl));
    relays.push(relay);
    let lostWith: string | undefined;
    const lock = await acquireRestoreSessionLock(relay.url, {
      onLost: (err) => (lostWith = err.message),
      livenessMs: 50,
      livenessTimeoutMs: 300,
    });
    try {
      expect(lock.pid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(lostWith).toBeUndefined();
      relay.cut();
      await eventually(() => lostWith);
      expect(lostWith).toMatch(/timed out|liveness|query/i);
    } finally {
      await lock.release();
    }
  }, 60_000);
});
