import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { checkPolicy } from '@agentic-marketing/email';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #452 and #453: the delivery caps. A cap decision must be race-free for messages queued in one
// transaction (equal created_at) and it must age a completed contact from the provider acceptance
// time, not from enqueue time: a backlog that waits for quiet hours or a retry still consumes the
// window from the moment it was really sent.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let policyId = '';

beforeAll(async () => {
  t = await startTestServer('test_message_caps', testPort(3594));
  owner = await t.signUp(`caps-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
}, 120_000);
afterAll(() => t?.close());

async function policy(content: Record<string, unknown>) {
  const api = t.api(owner, ws);
  const full = { quietHours: [], frequencyCaps: [], ...content };
  if (!policyId) {
    const a = await api.call('artifacts.create', { type: 'delivery_policy', name: 'Delivery policy', content: full });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'caps' });
    policyId = a.artifactId;
    return;
  }
  await api.call('artifacts.updateDraft', { artifactId: policyId, content: full });
  await api.call('artifacts.requestPublish', { artifactId: policyId, note: 'caps' });
}

async function person(id: string) {
  await t.srv.db.withWorkspace(ws, (tx) => tx.execute(sql`INSERT INTO profiles (workspace_id, id) VALUES (${ws}, ${id})`));
  return id;
}

type Msg = {
  id: string;
  profileId: string;
  createdAt: Date;
  updatedAt?: Date;
  status?: string;
  sentAt?: Date | null;
  agentId?: string | null;
  channel?: string;
  purpose?: string;
};

async function message(m: Msg) {
  await t.srv.db.withWorkspace(ws, (tx) =>
    tx.execute(sql`INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, test, agent_id, created_at, sent_at, updated_at)
      VALUES (${ws}, ${m.id}, ${m.id}, ${m.channel ?? 'email'}, ${m.profileId}, ${m.purpose ?? 'marketing_email'},
              ${m.status ?? 'sending'}, false, ${m.agentId ?? null}, ${m.createdAt.toISOString()},
              ${m.sentAt ? m.sentAt.toISOString() : null}, ${(m.updatedAt ?? m.createdAt).toISOString()})`),
  );
}

/** The real policy check for one message, as the send path runs it. */
async function hold(m: Msg, now = new Date()) {
  return t.srv.db.withWorkspace(ws, (tx) =>
    checkPolicy(
      tx,
      ws,
      {
        id: m.id,
        createdAt: m.createdAt,
        profileId: m.profileId,
        channel: (m.channel ?? 'email') as 'email',
        purpose: m.purpose ?? 'marketing_email',
        basis: 'consent',
        agentId: m.agentId ?? null,
      },
      DEFAULT_PURPOSES,
      now,
    ),
  );
}

describe('caps are race-free for equal enqueue times (#452)', () => {
  it('admits only the earlier of two in-flight messages under a max=1 frequency cap', async () => {
    await policy({ frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    const p = await person('prf_452_frequency');
    const at = new Date('2026-11-06T10:00:00.000Z');
    // One transaction in Postgres gives both rows the same now(): an ordinary batch state.
    const a: Msg = { id: 'msg_452_a', profileId: p, createdAt: at, agentId: 'agt_a' };
    const b: Msg = { id: 'msg_452_b', profileId: p, createdAt: at, agentId: 'agt_b' };
    await message(a);
    await message(b);
    expect(await hold(a, at)).toEqual({ ok: true });
    expect(await hold(b, at)).toEqual({
      ok: false,
      reason: 'frequency_cap: 1 e-mails in 7 days (at most 1)',
    });
  });

  it('reserves the slot for a peer another worker has not claimed yet', async () => {
    await policy({ frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    const p = await person('prf_452_queued');
    const at = new Date('2026-11-06T10:00:00.000Z');
    // The earlier reservation is still queued when the later one is claimed and checked; if the
    // queued row did not count, two workers could admit one message each before seeing the other.
    await message({ id: 'msg_452_q1', profileId: p, createdAt: at, status: 'queued' });
    const claimed: Msg = { id: 'msg_452_q2', profileId: p, createdAt: at };
    await message(claimed);
    expect(await hold(claimed, at)).toMatchObject({ ok: false, reason: expect.stringContaining('frequency_cap') });
  });

  it('admits only the earlier of two in-flight agent messages under contact pressure max=1', async () => {
    await policy({ frequencyCaps: [] });
    await t.api(owner, ws).call('workspace.setAutonomy', { contactPressure: [{ max: 1, days: 7 }] });
    const p = await person('prf_452_pressure');
    const at = new Date('2026-11-06T10:00:00.000Z');
    const human: Msg = {
      id: 'msg_452_h',
      profileId: p,
      createdAt: new Date(at.getTime() - 60_000),
      status: 'sent',
      sentAt: at,
      agentId: null,
    };
    const a: Msg = { id: 'msg_452_c', profileId: p, createdAt: at, agentId: 'agt_c' };
    const b: Msg = { id: 'msg_452_d', profileId: p, createdAt: at, agentId: 'agt_d' };
    await message(human);
    await message(a);
    await message(b);
    // A person's own message does not consume an agent's cap; the first agent message passes.
    expect(await hold(a, at)).toEqual({ ok: true });
    expect(await hold(b, at)).toEqual({
      ok: false,
      reason: 'agent_contact_pressure: 1 agent messages in 7 days (at most 1)',
    });
  });
});

describe('caps age completed contacts from the send time (#453)', () => {
  it('counts a message that waited eight days and was just sent', async () => {
    await policy({ frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    const p = await person('prf_453_late');
    const now = new Date('2026-11-06T12:00:00.000Z');
    const queuedEightDaysAgo = new Date(now.getTime() - 8 * 86_400_000);
    await message({
      id: 'msg_453_late',
      profileId: p,
      createdAt: queuedEightDaysAgo,
      status: 'sent',
      sentAt: new Date(now.getTime() - 60_000),
    });
    const next: Msg = { id: 'msg_453_next', profileId: p, createdAt: now };
    expect(await hold(next, now)).toMatchObject({ ok: false, reason: expect.stringContaining('frequency_cap') });
  });

  it('does not count a message sent eight days ago, even when its row was created now', async () => {
    await policy({ frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    const p = await person('prf_453_old');
    const now = new Date('2026-11-06T12:00:00.000Z');
    await message({
      id: 'msg_453_old',
      profileId: p,
      createdAt: now,
      status: 'delivered',
      sentAt: new Date(now.getTime() - 8 * 86_400_000),
    });
    const next: Msg = { id: 'msg_453_older_next', profileId: p, createdAt: now };
    expect(await hold(next, now)).toEqual({ ok: true });
  });

  it('uses the delivery-time boundary, not the enqueue-time one', async () => {
    await policy({ frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    const now = new Date('2026-11-06T12:00:00.000Z');
    const longAgo = new Date(now.getTime() - 30 * 86_400_000);
    const justOutside = await person('prf_453_outside');
    await message({
      id: 'msg_453_outside',
      profileId: justOutside,
      createdAt: longAgo,
      status: 'sent',
      sentAt: new Date(now.getTime() - 7 * 86_400_000 - 60_000),
    });
    expect(await hold({ id: 'msg_453_outside_next', profileId: justOutside, createdAt: now }, now)).toEqual({ ok: true });

    const justInside = await person('prf_453_inside');
    await message({
      id: 'msg_453_inside',
      profileId: justInside,
      createdAt: longAgo,
      status: 'sent',
      sentAt: new Date(now.getTime() - 6 * 86_400_000 - 3_600_000),
    });
    expect(await hold({ id: 'msg_453_inside_next', profileId: justInside, createdAt: now }, now)).toMatchObject({ ok: false });
  });

  it('falls back to updated_at for a completed row whose sent_at the background backfill has not filled yet', async () => {
    await policy({ frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    const p = await person('prf_453_backfill');
    const now = new Date('2026-11-06T12:00:00.000Z');
    const longAgo = new Date(now.getTime() - 30 * 86_400_000);
    // 0.10.0 wrote this row, 0082 added the column, and the batch job has not reached it yet:
    // sent_at is NULL but the last status change (updated_at) is recent, so it must still count.
    await message({
      id: 'msg_453_pending_backfill',
      profileId: p,
      createdAt: longAgo,
      updatedAt: new Date(now.getTime() - 60_000),
      status: 'sent',
      sentAt: null,
    });
    expect(await hold({ id: 'msg_453_backfill_next', profileId: p, createdAt: now }, now)).toMatchObject({ ok: false });
  });
});
