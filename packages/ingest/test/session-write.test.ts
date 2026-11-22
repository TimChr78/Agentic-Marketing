import type { Db } from '@agentic-marketing/db';
import type { EventBus } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { describe, expect, it } from 'vitest';
import { type IngestDeps, ingestApi } from '../src/gateway';
import { defaultPolicy } from '../src/policy';

// #1196: ingest used to ask the durable erasure ledger after writing sessions, and a failed lookup
// deleted the whole batch's sessions. A Postgres blip therefore wiped live visitors' hot state on
// the highest-volume path. The tombstone fence makes that check unnecessary: an erased subject's
// session write is refused by Valkey itself, and ingest never deletes a session.

const writeKey = 'wk_test';
const auth = `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}`;

function fakeServer(opts: { dbDown: () => boolean }) {
  const db = {
    admin: {
      query: async () => ({
        rows: [
          {
            id: 'src_1',
            workspace_id: '00000000-0000-4000-8000-000000000000',
            kind: 'server',
            required_purpose: null,
            enabled: true,
            allowed_origins: [],
          },
        ],
      }),
    },
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => {
      if (opts.dbDown()) throw new Error('database is down');
      // `loadPolicy` reads two published singletons; the fake answers with the default policy and
      // never touches a transaction, which is all this test needs.
      void fn;
      return { plan: null, purposes: defaultPolicy.purposes };
    },
  } as unknown as Db;
  const sessions: unknown[][] = [];
  const deletes: unknown[] = [];
  const hot = {
    take: async () => true,
    recordSessions: async (events: unknown[]) => {
      sessions.push(events);
    },
    deleteSnapshot: async (...args: unknown[]) => {
      deletes.push(args);
    },
  } as unknown as HotState;
  const bus = { publish: async () => ({ duplicates: 0 }) } as unknown as EventBus;
  return { db, hot, bus, sessions, deletes };
}

describe('ingest session writes', () => {
  it('keeps session state when Postgres is unavailable after the policy is cached', async () => {
    let down = false;
    const { db, hot, bus, sessions, deletes } = fakeServer({ dbDown: () => down });
    // A leftover from the first design: even if a caller still injects the ledger lookup, ingest
    // must not consult it or delete on its failure.
    const deps: IngestDeps = { db, hot, bus };
    (deps as unknown as { erasedAnonymousIds: (workspaceId: string, ids: string[]) => Promise<string[]> }).erasedAnonymousIds =
      async () => {
        throw new Error('database is down');
      };
    const app = ingestApi(deps);
    const send = () =>
      app.request('/v1/page', {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ anonymousId: 'visitor-1', name: 'Home', properties: {} }),
      });

    // Warm the source and policy caches, then take Postgres away: the request path no longer needs it.
    expect((await send()).status).toBe(200);
    down = true;
    expect((await send()).status).toBe(200);

    expect(sessions).toHaveLength(2);
    expect(deletes).toEqual([]);
  });
});
