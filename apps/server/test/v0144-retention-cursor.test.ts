import { randomUUID } from 'node:crypto';
import { runRetentionOnce } from '@agentic-marketing/audience';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Sol's P2 reproducer: 200 kept candidates share one microsecond-precision created_at, then an
// eligible signup. A cursor that saves milliseconds sees every kept row as still after it and
// repeats the first page forever; the cursor must carry PostgreSQL's full precision.

const PORT = testPort(4334);
const SHARED = '2026-01-01 00:00:00.123456+00';
const KEPT = 200;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let seq = 0;

function storedEvent(anon: string, name: string): BusEvent {
  const at = new Date().toISOString();
  return {
    workspaceId: ws,
    sourceId: 'frm_test',
    messageId: `retention-cursor:${anon}:${name}:${++seq}`,
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

async function seedProfile(anon: string, email: string, createdAt: string, id = `prf_${randomUUID().replaceAll('-', '')}`) {
  const old = new Date(Date.now() - 40 * 86_400_000);
  await t.srv.db.admin.query(
    `INSERT INTO profiles (workspace_id, id, created_at, first_seen, last_seen) VALUES ($1, $2, $3::timestamptz, $4, $4)`,
    [ws, id, createdAt, old],
  );
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
  t = await startTestServer('test_v0144_retention_cursor', PORT);
  owner = await t.signUp(`owner-cursor-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);

afterAll(() => t?.close());

describe('retention cursor precision (#627 review)', () => {
  it('pages past 200 candidates that share one microsecond timestamp', async () => {
    await t.srv.db.admin.query(
      `INSERT INTO profiles (workspace_id, id, created_at, first_seen, last_seen)
       SELECT $1::uuid, 'prf_' || lpad(i::text, 32, '0'), $2::timestamptz,
              now() - interval '45 days', now() - interval '45 days'
       FROM generate_series(1, ${KEPT}) i`,
      [ws, SHARED],
    );
    await t.srv.db.admin.query(
      `INSERT INTO identifiers (workspace_id, type, value, profile_id, first_seen, last_seen)
       SELECT $1::uuid, 'anonymous_id', 'form:precise:' || i, 'prf_' || lpad(i::text, 32, '0'),
              now() - interval '45 days', now() - interval '45 days'
       FROM generate_series(1, ${KEPT}) i
       UNION ALL
       SELECT $1::uuid, 'email', 'precise' || i || '@example.com', 'prf_' || lpad(i::text, 32, '0'),
              now() - interval '45 days', now() - interval '45 days'
       FROM generate_series(1, ${KEPT}) i`,
      [ws],
    );
    await t.srv.events.insert(Array.from({ length: KEPT }, (_, i) => storedEvent(`form:precise:${i + 1}`, 'Viewed Pricing')));

    const eligible = `prf_${'f'.repeat(32)}`;
    const anon = 'form:precise-eligible';
    await seedProfile(anon, 'precise-eligible@example.com', SHARED, eligible);
    await t.srv.events.insert([storedEvent(anon, 'Form Submitted')]);

    let removed = 0;
    let rounds = 0;
    while (removed === 0 && rounds < 10) {
      removed += (await runRetentionOnce({ db: t.srv.db, events: t.srv.events, hot: t.srv.hot, unconfirmedDays: 30, logDays: 180 }))
        .profiles;
      rounds++;
    }
    expect(removed).toBe(1);
    expect(rounds).toBeLessThanOrEqual(3);
    expect(await exists(eligible)).toBe(false);
  }, 120_000);
});
