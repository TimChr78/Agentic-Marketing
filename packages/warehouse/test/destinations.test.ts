import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:net';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Erasure } from '../src/datasets';
import { postgresConfig, postgresDestination, postgresSecrets } from '../src/destinations';

// #237: the destination used to check the host with one DNS lookup and then let pg resolve it
// again when connecting, so an answer that changed in between reached a private address.
const none = { allowedHosts: [] };
const ws = '00000000-0000-4000-8000-000000000001';
const url = (port: number) => `postgres://am:am@db.example.test:${port}/am`;

function fakeClient() {
  const queries: string[] = [];
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    connected: false,
    queries,
    calls,
    async connect() {
      this.connected = true;
    },
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      calls.push({ sql, params });
      return { rows: [] };
    },
    async end() {},
  };
}

/** A resolver stub with a fixed queue of answers, so it can change its mind between calls. */
function resolver(answers: LookupAddress[][]) {
  const calls: string[] = [];
  return {
    calls,
    async lookup(host: string) {
      calls.push(host);
      const answer = answers.shift();
      if (!answer) throw new Error(`unexpected extra resolution of ${host}`);
      return answer;
    },
  };
}

describe('postgres destination egress', () => {
  it('connects to the validated address instead of resolving the name a second time', async () => {
    const srv = createServer((socket) => socket.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const lookup = resolver([
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '10.0.0.1', family: 4 }], // a rebinding answer the client must never ask for
    ]);
    const client = fakeClient();
    let config: pg.ClientConfig | undefined;
    try {
      const destination = await postgresDestination(
        ws,
        postgresConfig.parse({}),
        postgresSecrets.parse({ url: url(port) }),
        { allowedHosts: ['127.0.0.1'] },
        {
          lookup: lookup.lookup,
          createClient: (c) => {
            config = c;
            return client as unknown as pg.Client;
          },
        },
      );
      expect(lookup.calls).toEqual(['db.example.test']);
      expect(client.connected).toBe(true);

      // pg asks the stream for `connect(port, 'db.example.test')`; the stream must dial the
      // address that passed the check, and TLS keeps verifying the original name (pg passes it).
      expect(config?.stream).toBeTypeOf('function');
      const socket = config!.stream!() as unknown as Socket;
      socket.connect(port, 'db.example.test');
      await once(socket, 'connect');
      expect(socket.remoteAddress).toBe('127.0.0.1');
      expect(socket.remotePort).toBe(port);
      socket.destroy();
      await destination.close();
    } finally {
      srv.close();
    }
  });

  it('rejects mixed public and private answers before connecting', async () => {
    const lookup = resolver([
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    ]);
    const client = fakeClient();
    let created = false;
    await expect(
      postgresDestination(ws, postgresConfig.parse({}), postgresSecrets.parse({ url: url(5432) }), none, {
        lookup: lookup.lookup,
        createClient: () => {
          created = true;
          return client as unknown as pg.Client;
        },
      }),
    ).rejects.toThrow(/private address 10\.0\.0\.1/);
    expect(created).toBe(false);
    expect(client.connected).toBe(false);
    expect(lookup.calls).toEqual(['db.example.test']);
  });

  it('still reaches an explicitly allowed private host, pinned to its answer', async () => {
    const lookup = resolver([[{ address: '10.0.0.5', family: 4 }]]);
    const client = fakeClient();
    let config: pg.ClientConfig | undefined;
    const destination = await postgresDestination(
      ws,
      postgresConfig.parse({}),
      postgresSecrets.parse({ url: url(5432) }),
      { allowedHosts: ['db.example.test'] },
      {
        lookup: lookup.lookup,
        createClient: (c) => {
          config = c;
          return client as unknown as pg.Client;
        },
      },
    );
    expect(lookup.calls).toEqual(['db.example.test']);
    expect(config?.stream).toBeTypeOf('function');
    expect(client.connected).toBe(true);
    await destination.close();
  });
});

// #373: an events-only destination never receives am_identifiers. Erasure must still find and
// delete the person's events, and must not record success when it cannot.
describe('postgres destination erasure', () => {
  const erasure = (over: Partial<Erasure> = {}): Erasure => ({
    id: 'era_00000000000000000000000000000001',
    profileIds: ['prf_a'],
    at: '2026-11-01T00:00:00.000Z',
    identifiers: [
      { type: 'user_id', value: 'u-1' },
      { type: 'anonymous_id', value: 'a-1' },
    ],
    uncovered: [],
    ...over,
  });

  async function destination() {
    const client = fakeClient();
    const dest = await postgresDestination(
      ws,
      postgresConfig.parse({}),
      postgresSecrets.parse({ url: url(5432) }),
      { allowedHosts: ['db.example.test'] },
      {
        lookup: async () => [{ address: '10.0.0.5', family: 4 }],
        createClient: () => client as unknown as pg.Client,
      },
    );
    client.calls.length = 0;
    return { dest, client };
  }

  it('adds the coverage columns to a destination created by an earlier version', async () => {
    const client = fakeClient();
    const dest = await postgresDestination(
      ws,
      postgresConfig.parse({}),
      postgresSecrets.parse({ url: url(5432) }),
      { allowedHosts: ['db.example.test'] },
      {
        lookup: async () => [{ address: '10.0.0.5', family: 4 }],
        createClient: () => client as unknown as pg.Client,
      },
    );
    const alters = client.queries.filter((q) => q.includes('am_erasures') && q.includes('ADD COLUMN IF NOT EXISTS'));
    expect(alters.join('\n')).toMatch(/applied boolean NOT NULL DEFAULT true/);
    expect(alters.join('\n')).toMatch(/uncovered text\[\]/);
    await dest.close();
  });

  it('deletes events by the captured ids instead of the never-exported identifiers table', async () => {
    const { dest, client } = await destination();
    const report = await dest.erase([erasure()]);
    expect(report).toEqual({ applied: 1, incomplete: [] });

    const remove = client.calls.find((c) => /DELETE FROM "agentic_marketing"\.am_events/.test(c.sql));
    expect(remove?.sql).toContain('user_id = ANY($2) OR anonymous_id = ANY($3)');
    expect(remove?.params).toEqual([ws, ['u-1'], ['a-1']]);
    // The old join through am_identifiers is gone: an events-only destination has no such rows.
    expect(client.queries.some((q) => q.includes('USING "agentic_marketing".am_identifiers'))).toBe(false);

    const recorded = client.calls.find((c) => c.sql.includes('INSERT INTO "agentic_marketing".am_erasures'));
    expect(recorded?.params).toEqual([ws, erasure().id, ['prf_a'], erasure().at, true, null]);
  });

  it('reports an erasure it cannot cover instead of recording a silent success', async () => {
    const { dest, client } = await destination();
    const report = await dest.erase([erasure({ identifiers: [], uncovered: ['events'] })]);
    expect(report).toEqual({ applied: 0, incomplete: [{ id: erasure().id, uncovered: ['events'] }] });

    const recorded = client.calls.find((c) => c.sql.includes('INSERT INTO "agentic_marketing".am_erasures'));
    expect(recorded?.params.slice(4)).toEqual([false, ['events']]);
  });
});
