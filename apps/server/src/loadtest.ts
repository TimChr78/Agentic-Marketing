import { newUuid } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { type PublishedSegment, refreshSegment } from '@agentic-marketing/segments';

// Load test for the data platform at scale: seeds a throwaway workspace with synthetic people
// (traits, a user id, consent) and their events straight into Postgres and ClickHouse, then
// times whole-segment refreshes and a re-run with nothing to change. The data is deterministic,
// so every segment's size is known in advance and checked.
//
//   pnpm --filter @agentic-marketing/server cli loadtest --profiles 1000000

export interface LoadTestReport {
  profiles: number;
  events: number;
  seedMs: number;
  segments: { name: string; members: number; expected: number; firstMs: number; againMs: number }[];
  /** Peak memory of this process (the evaluator's side; Postgres and ClickHouse do the heavy lifting). */
  peakRssMb: number;
}

/** Profile i: plan "pro" when i % 4 = 0, consent to marketing e-mail when i is even, i % 4 product views, an order when i % 10 = 0. */
export const SEGMENTS: { name: string; condition: PublishedSegment['definition']['condition']; expected: (n: number) => number }[] = [
  { name: 'trait: plan = pro', condition: { trait: 'plan', op: 'eq', value: 'pro' }, expected: (n) => count(n, (i) => i % 4 === 0) },
  {
    name: 'event: 2+ product views in 7 days',
    condition: { event: 'Product Viewed', count: { gte: 2 }, within: 'P7D' },
    expected: (n) => count(n, (i) => i % 4 >= 2),
  },
  { name: 'event: never viewed', condition: { event: 'Product Viewed', count: { lte: 0 } }, expected: (n) => count(n, (i) => i % 4 === 0) },
  { name: 'consent: marketing e-mail', condition: { consent: 'marketing_email' }, expected: (n) => count(n, (i) => i % 2 === 0) },
  {
    name: 'combined: viewed 2+, no order, consented',
    condition: {
      all: [
        { event: 'Product Viewed', count: { gte: 2 }, within: 'P7D' },
        { not: { event: 'Order Completed' } },
        { consent: 'marketing_email' },
      ],
    },
    expected: (n) => count(n, (i) => i % 4 === 2 && i % 10 !== 0),
  },
];

function count(n: number, f: (i: number) => boolean) {
  let c = 0;
  for (let i = 0; i < n; i++) if (f(i)) c++;
  return c;
}

export async function seedSynthetic(db: Db, events: EventStore, workspaceId: string, n: number) {
  await db.admin.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, `Load test (${n} profiles)`]);
  await db.admin.query(
    `INSERT INTO profiles (workspace_id, id, traits)
     SELECT $1, 'prf_' || lpad(to_hex(i), 32, '0'),
            jsonb_build_object('plan', CASE WHEN i % 4 = 0 THEN 'pro' ELSE 'free' END, 'score', i % 100)
     FROM generate_series(0, $2 - 1) i`,
    [workspaceId, n],
  );
  await db.admin.query(
    `INSERT INTO identifiers (workspace_id, type, value, profile_id)
     SELECT $1, 'user_id', 'lt-' || i, 'prf_' || lpad(to_hex(i), 32, '0') FROM generate_series(0, $2 - 1) i`,
    [workspaceId, n],
  );
  await db.admin.query(
    `INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
     SELECT $1, 'prf_' || lpad(to_hex(i), 32, '0'), 'marketing_email', '', 'granted', 'consent', 'loadtest', now()
     FROM generate_series(0, $2 - 1, 2) i`,
    [workspaceId, n],
  );
  for (const table of ['profiles', 'identifiers', 'consent_state']) await db.admin.query(`ANALYZE ${table}`);
  const settings = (await events.settingsFor(workspaceId)) as never;
  const insert = (select: string) =>
    events.client.command({
      query: `INSERT INTO events (workspace_id, event_id, source_id, received_at, timestamp, type, name, anonymous_id, user_id,
                properties, traits, context, consent) ${select}`,
      query_params: { ws: workspaceId, n },
      clickhouse_settings: settings,
    });
  // i % 4 views per person (k-th view of person i is row k * n + i), and an order for every tenth.
  await insert(`SELECT {ws:UUID}, concat('lt-v-', toString(number)), 'loadtest', now64(3), now64(3) - toIntervalMinute(number % 1440),
      'track', 'Product Viewed', '', concat('lt-', toString(number % {n:UInt64})), '{"category":"tents"}', '{}', '{}', map()
    FROM numbers({n:UInt64} * 3) WHERE intDiv(number, {n:UInt64}) < (number % {n:UInt64}) % 4`);
  await insert(`SELECT {ws:UUID}, concat('lt-o-', toString(number)), 'loadtest', now64(3), now64(3),
      'track', 'Order Completed', '', concat('lt-', toString(number)), '{"total":10}', '{}', '{}', map()
    FROM numbers({n:UInt64}) WHERE number % 10 = 0`);
  // Events stored: every person's views, plus the orders.
  let views = 0;
  for (let i = 0; i < n; i++) views += i % 4;
  return views + Math.ceil(n / 10);
}

export async function runLoadTest(
  deps: { db: Db; events: EventStore },
  opts: { profiles: number; keep?: boolean; log?: (m: string) => void },
): Promise<LoadTestReport & { workspaceId: string }> {
  const log = opts.log ?? (() => {});
  const workspaceId = newUuid();
  const n = opts.profiles;
  let started = Date.now();
  log(`seeding ${n} profiles in workspace ${workspaceId}…`);
  const eventCount = await seedSynthetic(deps.db, deps.events, workspaceId, n);
  const seedMs = Date.now() - started;
  log(`seeded ${n} profiles and ${eventCount} events in ${seedMs} ms`);
  const all: PublishedSegment[] = SEGMENTS.map((s, i) => ({
    id: `seg_${(i + 1).toString(16).padStart(32, '0')}`,
    name: s.name,
    version: 1,
    definition: { description: '', condition: s.condition },
  }));
  const report: LoadTestReport = { profiles: n, events: eventCount, seedMs, segments: [], peakRssMb: 0 };
  try {
    for (const [i, seg] of all.entries()) {
      const refresh = () => deps.db.withWorkspace(workspaceId, (tx) => refreshSegment(tx, workspaceId, seg, deps.events, all));
      started = Date.now();
      const first = await refresh();
      const firstMs = Date.now() - started;
      started = Date.now();
      const again = await refresh();
      const againMs = Date.now() - started;
      const expected = SEGMENTS[i].expected(n);
      if (first.members !== expected || first.entered !== expected || again.entered + again.exited !== 0)
        throw new Error(`${seg.name}: ${first.members} members (expected ${expected}), re-run moved ${again.entered + again.exited}`);
      report.segments.push({ name: seg.name, members: first.members, expected, firstMs, againMs });
      log(`${seg.name}: ${first.members} members, first run ${firstMs} ms, re-run ${againMs} ms`);
    }
  } finally {
    if (!opts.keep) {
      await deps.db.admin.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await deps.events.client.command({
        query: 'DELETE FROM events WHERE workspace_id = {ws:UUID}',
        query_params: { ws: workspaceId },
        clickhouse_settings: (await deps.events.settingsFor(workspaceId)) as never,
      });
    }
  }
  report.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  return { ...report, workspaceId };
}
