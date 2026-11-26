import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { newUuid } from '@agentic-marketing/core';
import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../db/test/run';
import {
  acceptsWorkspaceSetting,
  applyRowPolicies,
  type BusEvent,
  clickHouseStore,
  type EventStore,
  migrateClickHouse,
  resetClickHouse,
  workspaceSettings,
} from '../src';

// #1225: the store probes once whether ClickHouse accepts the `SQL_workspace` setting and cached the
// answer for the life of the process. `acceptsWorkspaceSetting` swallowed every error, so a dropped
// connection or a timeout at start was remembered as "the server does not accept SQL_ custom
// settings". With row policies applied (the Compose and Helm default) every later read then ran
// without the setting and the policy hid every row: reads returned nothing, without an error.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_events_workspace_probe');
const ws = newUuid();
const hasher = {
  version: 'dk_probe_test',
  hash: async (kind: string, value: string) => createHmac('sha256', Buffer.alloc(32, 17)).update(`${kind}:${value}`).digest('hex'),
  dispose() {},
};

const event: BusEvent = {
  workspaceId: ws,
  sourceId: 'src_probe',
  messageId: 'probe-1',
  type: 'track',
  name: 'Probe Event',
  anonymousId: 'anon-probe',
  userId: 'user-probe',
  profileId: 'prf_probe',
  timestamp: '2026-11-01T12:00:00.000Z',
  receivedAt: '2026-11-01T12:00:00.000Z',
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
};

/**
 * A TCP relay in front of ClickHouse whose first connection is dropped before any bytes are
 * forwarded, like a server that is still starting. Later connections are forwarded normally.
 */
async function droppingFirstConnection(): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const upstream = new URL(CH_URL);
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket: Socket) => {
    connections++;
    if (connections === 1) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const target = connect(Number(upstream.port), upstream.hostname, () => {
      target.pipe(socket);
      socket.pipe(target);
    });
    sockets.add(target);
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      target.destroy();
    });
    target.on('close', () => sockets.delete(target));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let healthy: EventStore;
const stores: EventStore[] = [];
const relays: Awaited<ReturnType<typeof droppingFirstConnection>>[] = [];

beforeAll(async () => {
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB, undefined, { rowPolicies: 'required' });
  healthy = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: async () => hasher });
  stores.push(healthy);
  await healthy.insert([event]);
}, 120_000);

afterAll(async () => {
  for (const store of stores) await store?.close().catch(() => {});
  for (const relay of relays) await relay.close();
});

describe('a transient failure of the SQL_workspace probe (#1225)', () => {
  it('rejects the first read, then probes again and sees the workspace rows', async () => {
    const relay = await droppingFirstConnection();
    relays.push(relay);
    const ids = { anonymousIds: ['anon-probe'], userIds: [] };

    // The control store talks to ClickHouse directly and sees the row.
    expect(await healthy.eventsOf(ws, ids)).toHaveLength(1);

    const store = clickHouseStore({ url: relay.url, database: CH_DB, subjectKeys: async () => hasher, rowPolicies: 'required' });
    stores.push(store);
    // The store's first request is the probe, and the relay drops that connection. The failure must
    // reach the caller instead of being cached as "not accepted".
    await expect(store.eventsOf(ws, ids)).rejects.toThrow();
    // The cache was left empty, so the next request probes again — this time ClickHouse answers —
    // and the read names the workspace and returns its row.
    expect(await store.settingsFor(ws)).toEqual({ SQL_workspace: ws });
    expect(await store.eventsOf(ws, ids)).toHaveLength(1);
  }, 120_000);

  it('treats only the server\'s unknown-setting answer as "not accepted", never a transport failure', async () => {
    const answer = (err: unknown) => ({
      command: async () => {
        throw err;
      },
    });
    const unknownSetting = Object.assign(new Error("Unknown setting 'SQL_workspace'"), { code: '115', type: 'UNKNOWN_SETTING' });
    expect(await acceptsWorkspaceSetting(answer(unknownSetting) as never)).toBe(false);
    // Anything else rejects so the caller fails and retries instead of caching a "no".
    await expect(acceptsWorkspaceSetting(answer(new Error('ECONNRESET socket hang up')) as never)).rejects.toThrow(/ECONNRESET/);
    await expect(acceptsWorkspaceSetting(answer(Object.assign(new Error('timeout'), { code: '159' })) as never)).rejects.toThrow(/timeout/);
  });

  it('refuses to read in required mode when the server really does not take the setting', () => {
    // Not accepting `SQL_` is a definite answer only from an UNKNOWN_SETTING error. A store told the
    // policies are required must fail loudly instead of running every later read without the
    // setting, which the policy would answer with zero rows.
    expect(() => workspaceSettings(ws, false, 'required')).toThrow(/refusing to read/);
    expect(workspaceSettings(ws, false, 'auto')).toEqual({});
    expect(workspaceSettings(ws, true, 'off')).toEqual({ SQL_workspace: ws });
  });

  it('does not treat a failed probe as "not accepted" when applying row policies in auto mode', async () => {
    const relay = await droppingFirstConnection();
    relays.push(relay);
    const client = createClient({ url: relay.url, database: CH_DB, request_timeout: 30_000 });
    try {
      await expect(applyRowPolicies(client, CH_DB, 'auto')).rejects.toThrow(/did not answer the SQL_ setting probe/);
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);
});
