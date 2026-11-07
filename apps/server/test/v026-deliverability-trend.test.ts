import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// B5 (Phase 26, #508): deliverability.trend reads current message statuses by creation time and
// reports workspace-local daily points under the delivery policy's rolling duration.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let other: User;

beforeAll(async () => {
  t = await startTestServer('test_v026_trend', testPort(3530));
  owner = await t.signUp(`trend-owner-${Date.now()}@example.com`);
  other = await t.signUp(`trend-other-${Date.now()}@example.com`);
});
afterAll(() => t?.close());

async function workspace(user: User = owner, timeZone = 'UTC') {
  const id = await t.workspaceWith([[user, 'owner']]);
  await t.srv.db.admin.query('UPDATE workspaces SET time_zone = $2 WHERE id = $1', [id, timeZone]);
  return id;
}

async function message(
  ws: string,
  at: string,
  status: 'sent' | 'delivered' | 'bounced' | 'complained' = 'delivered',
  overrides: { channel?: 'email' | 'sms'; purpose?: string; test?: boolean } = {},
) {
  const id = `msg_${newUuid().replace(/-/g, '')}`;
  await t.srv.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, status, test, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [ws, id, id, overrides.channel ?? 'email', overrides.purpose ?? 'marketing_email', status, overrides.test ?? false, at],
  );
  return id;
}

const trend = (ws: string, from: string, to: string, extra: { channel?: 'email' | 'sms'; stream?: 'marketing' | 'transactional' } = {}) =>
  t.api(owner, ws).call('deliverability.trend', {
    from,
    to,
    channel: extra.channel ?? 'email',
    stream: extra.stream ?? 'marketing',
  });

describe('deliverability.trend ranges', () => {
  it('rejects an empty or reversed range', async () => {
    const ws = await workspace();
    await expect(trend(ws, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(trend(ws, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses more than 90 daily points', async () => {
    const ws = await workspace();
    await expect(trend(ws, '2026-01-01T00:00:00Z', '2026-04-02T00:00:00Z')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('deliverability.trend tenant isolation', () => {
  it('never counts another workspace’s messages', async () => {
    const a = await workspace(owner);
    const b = await workspace(other);
    await message(a, '2026-02-10T10:00:00Z');
    await message(a, '2026-02-10T11:00:00Z');

    const mine = await trend(a, '2026-02-09T00:00:00Z', '2026-02-11T00:00:00Z');
    expect(mine.points.find((p) => p.day === '2026-02-10')).toMatchObject({ sent: 2, bounced: 0, complained: 0 });

    const theirs = await t.api(other, b).call('deliverability.trend', {
      from: '2026-02-09T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
      channel: 'email',
      stream: 'marketing',
    });
    expect(theirs.points.find((p) => p.day === '2026-02-10')).toMatchObject({
      sent: 0,
      bounced: 0,
      complained: 0,
      bounceRate: null,
    });
  });
});

describe('deliverability.trend purpose classification', () => {
  it('returns empty points when no published purpose belongs to the stream', async () => {
    const ws = await workspace();
    const api = t.api(owner, ws);
    const purposes = await api.call('artifacts.create', {
      type: 'purposes',
      name: 'Consent-only purposes',
      content: {
        purposes: [{ key: 'marketing_email', name: 'Marketing e-mail', basis: 'consent', channels: ['email'] }],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: purposes.artifactId, note: 'test' });
    // A contract-purpose message exists, but no transactional purpose is published.
    await message(ws, '2026-03-10T10:00:00Z', 'delivered', { purpose: 'onboarding' });

    const transactional = await trend(ws, '2026-03-09T00:00:00Z', '2026-03-11T00:00:00Z', { stream: 'transactional' });
    expect(transactional.points).toHaveLength(2);
    for (const point of transactional.points) expect(point).toMatchObject({ sent: 0, bounceRate: null, complaintRate: null });
  });
});

describe('deliverability.trend current statuses', () => {
  it('revises an earlier point after a late bounce', async () => {
    const ws = await workspace();
    const id = await message(ws, '2026-02-10T10:00:00Z', 'sent');

    const before = await trend(ws, '2026-02-10T00:00:00Z', '2026-02-11T00:00:00Z');
    expect(before.points[0]).toMatchObject({ sent: 1, bounced: 0, bounceRate: 0 });

    await t.srv.db.admin.query(`UPDATE messages SET status = 'bounced', updated_at = now() WHERE workspace_id = $1 AND id = $2`, [ws, id]);
    const after = await trend(ws, '2026-02-10T00:00:00Z', '2026-02-11T00:00:00Z');
    expect(after.points[0]).toMatchObject({ sent: 1, bounced: 1, bounceRate: 1 });
    expect(after.semantics).toBe('current_status_by_creation_window');
  });

  it('excludes test messages and the other channel', async () => {
    const ws = await workspace();
    await message(ws, '2026-02-10T10:00:00Z', 'delivered', { test: true });
    await message(ws, '2026-02-10T11:00:00Z', 'delivered', { channel: 'sms' });
    await message(ws, '2026-02-10T12:00:00Z', 'delivered');
    const out = await trend(ws, '2026-02-10T00:00:00Z', '2026-02-11T00:00:00Z');
    expect(out.points[0]!.sent).toBe(1);
  });
});

describe('deliverability.trend empty and low volume', () => {
  it('returns null rates on a zero denominator', async () => {
    const ws = await workspace();
    const out = await trend(ws, '2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z');
    expect(out.points).toHaveLength(2);
    for (const point of out.points) expect(point).toMatchObject({ sent: 0, bounceRate: null, complaintRate: null });
  });

  it('computes rates below minVolume; the surface withholds them', async () => {
    const ws = await workspace();
    for (let i = 0; i < 10; i++) await message(ws, `2026-05-02T${String(10 + i).padStart(2, '0')}:00:00Z`, 'delivered');
    await message(ws, '2026-05-02T20:00:00Z', 'bounced');
    const out = await trend(ws, '2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z');
    const point = out.points.find((p) => p.day === '2026-05-02')!;
    expect(point.sent).toBe(11);
    expect(point.bounced).toBe(1);
    expect(point.bounceRate).toBeCloseTo(1 / 11);
    expect(out.thresholds.minVolume).toBeGreaterThan(point.sent);
  });
});

describe('deliverability.trend daylight saving', () => {
  it('uses fixed-duration windows and workspace-local midnight points', async () => {
    const ws = await workspace(owner, 'Europe/Copenhagen');
    // The boundary is 2026-10-26 00:00 CET (23:00Z). Seven fixed days earlier is 2026-10-18T23:00Z,
    // not the local midnight 2026-10-18T22:00Z (still CEST).
    await message(ws, '2026-10-18T22:30:00Z'); // outside the fixed window
    await message(ws, '2026-10-18T23:30:00Z'); // inside
    await message(ws, '2026-10-25T12:00:00Z'); // inside

    const out = await trend(ws, '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z');
    expect(out.timeZone).toBe('Europe/Copenhagen');
    expect(out.points).toHaveLength(1);
    expect(out.points[0]).toMatchObject({
      day: '2026-10-25',
      windowFrom: '2026-10-18T23:00:00.000Z',
      windowTo: '2026-10-25T23:00:00.000Z',
      sent: 2,
    });
  });
});

describe('deliverability.trend policy metadata', () => {
  it('reports the policy window, thresholds and empty autoPause separately from the points', async () => {
    const ws = await workspace();
    const out = await trend(ws, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
    expect(out).toMatchObject({
      windowDays: 7,
      autoPause: true,
      thresholds: { complaintWarn: 0.001, complaintStop: 0.003, bounceStop: 0.05, minVolume: 200 },
      timeZone: 'UTC',
    });
    expect(Date.parse(out.computedAt)).not.toBeNaN();
  });
});
