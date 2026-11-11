import { randomUUID } from 'node:crypto';
import { runRetentionOnce } from '@agentic-marketing/audience';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// P2-2 from Sol's review: 500+ kept candidates must not starve an eligible signup behind them.
// A fresh server and database keep the physical candidate order deterministic for the old
// unordered LIMIT 500, so this test fails on patch/0.14.4 rather than accidentally seeing the
// eligible profile inside the first page.

const PORT = testPort(4333);
const KEPT = 600;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let seq = 0;

function storedEvent(anon: string, name: string): BusEvent {
  const at = new Date().toISOString();
  return {
    workspaceId: ws,
    sourceId: 'frm_test',
    messageId: `retention-paging:${anon}:${name}:${++seq}`,
    type: 'track',
    name,
    anonymousId: anon,
    userId: '',
    timestamp: at,
    receivedAt: at,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  };
}

async function seedProfile(anon: string, email: string, createdAt: Date, id = `prf_${randomUUID().replaceAll('-', '')}`) {
  const old = new Date(Date.now() - 40 * 86_400_000);
  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id, created_at, first_seen, last_seen) VALUES ($1, $2, $3, $4, $4)`, [
    ws,
    id,
    createdAt,
    old,
  ]);
  await t.srv.db.admin.query(
    `INSERT INTO identifiers (workspace_id, type, value, profile_id, first_seen, last_seen)
     VALUES ($1, 'anonymous_id', $2, $3, $4, $4), ($1, 'email', $5, $3, $4, $4)`,
    [ws, anon, id, old, email],
  );
  return id;
}

const exists = async (id: string) =>
  (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, id]))
    .rows[0].n === 1;

beforeAll(async () => {
  t = await startTestServer('test_v0144_retention_paging', PORT);
  owner = await t.signUp(`owner-paging-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);

afterAll(() => t?.close());

describe('retention paging (#627 review)', () => {
  it('reaches an eligible signup behind 500+ kept candidates within a bounded number of rounds', async () => {
    // Each kept candidate matches the candidate SQL but has non-platform activity, so both the
    // old and the new rule keep it.
    await t.srv.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, created_at, first_seen, last_seen)
       SELECT $1::uuid, 'prf_' || lpad(i::text, 32, '0'),
              now() - interval '70 days' + (i || ' seconds')::interval,
              now() - interval '45 days', now() - interval '45 days'
       FROM generate_series(1, ${KEPT}) i`,
      [ws],
    );
    await t.srv.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id, first_seen, last_seen)
       SELECT $1::uuid, 'anonymous_id', 'form:keep:' || i, 'prf_' || lpad(i::text, 32, '0'),
              now() - interval '45 days', now() - interval '45 days'
       FROM generate_series(1, ${KEPT}) i
       UNION ALL
       SELECT $1::uuid, 'email', 'keep' || i || '@example.com', 'prf_' || lpad(i::text, 32, '0'),
              now() - interval '45 days', now() - interval '45 days'
       FROM generate_series(1, ${KEPT}) i`,
      [ws],
    );
    await t.srv.events.insert(Array.from({ length: KEPT }, (_, i) => storedEvent(`form:keep:${i + 1}`, 'Viewed Pricing')));

    // The eligible one sorts last by creation time and by id, so the old unordered LIMIT 500
    // cannot reach it, while the cursor must within a few rounds.
    const eligible = `prf_${'f'.repeat(32)}`;
    const anon = 'form:behind-kept';
    await seedProfile(anon, 'behind-kept@example.com', new Date(Date.now() - 50 * 86_400_000), eligible);
    await t.srv.events.insert([storedEvent(anon, 'Form Submitted')]);

    let removed = 0;
    let rounds = 0;
    while (removed === 0 && rounds < 10) {
      removed += (await runRetentionOnce({ db: t.srv.db, events: t.srv.events, hot: t.srv.hot, unconfirmedDays: 30, logDays: 180 }))
        .profiles;
      rounds++;
    }
    expect(removed).toBe(1);
    expect(rounds).toBeLessThanOrEqual(5);
    expect(await exists(eligible)).toBe(false);
    expect(
      (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1', [ws])).rows[0].n,
    ).toBe(KEPT);
  }, 120_000);
});
