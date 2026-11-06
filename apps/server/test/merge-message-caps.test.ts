import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { checkPolicy } from '@agentic-marketing/email';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #460: an identity merge moved journeys and consent but left messages on the merged-away profile,
// so the survivor's frequency and cross-agent caps saw no history and the same person could be
// contacted again immediately. The merge now re-points the messages in the same transaction.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let sourceKey = '';
let policyId = '';

beforeAll(async () => {
  t = await startTestServer('test_merge_message_caps', testPort(3593));
  owner = await t.signUp(`merge-caps-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  sourceKey = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await api.call('workspace.setAutonomy', { contactPressure: [{ max: 1, days: 7 }] });
}, 120_000);
afterAll(() => t?.close());

const identify = (body: Record<string, unknown>) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${sourceKey}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch: [{ type: 'identify', ...body }] }),
  });

async function profileOf(lookup: { type: 'user_id' | 'anonymous_id'; value: string }) {
  return (
    await eventually(
      () => t.api(owner, ws).call('profiles.find', lookup),
      (r) => !!r.profileId,
    )
  ).profileId!;
}

const mergedInto = (loser: string, survivor: string) =>
  eventually(
    async () =>
      (
        await t.srv.db.withWorkspace(ws, (tx) =>
          tx.execute<{ merged_into: string | null }>(sql`SELECT merged_into FROM profiles WHERE workspace_id = ${ws} AND id = ${loser}`),
        )
      ).rows[0]?.merged_into ?? null,
    (id) => id === survivor,
  );

describe('identity merges keep the message history for the caps (#460)', () => {
  it('moves messages through chained merges and both caps see them', async () => {
    // Three profiles for one person, oldest first: C, A, B.
    await identify({ userId: 'u-merge-c' });
    const c = await profileOf({ type: 'user_id', value: 'u-merge-c' });
    await identify({ anonymousId: 'anon-merge-a' });
    const a = await profileOf({ type: 'anonymous_id', value: 'anon-merge-a' });
    await identify({ anonymousId: 'anon-merge-b', traits: { email: 'merge-caps@example.com' } });
    const b = await profileOf({ type: 'anonymous_id', value: 'anon-merge-b' });
    expect(new Set([a, b, c]).size).toBe(3);

    // B was reached by an agent's marketing message a minute ago.
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, test, agent_id, created_at, sent_at, updated_at)
        VALUES (${ws}, 'msg_460_b', 'msg_460_b', 'email', ${b}, 'marketing_email', 'sent', false, 'agt_merge',
                now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute')`),
    );

    // B → A (shared e-mail), then A → C (userId u-merge-c), so the survivor inherits a chain.
    await identify({ anonymousId: 'anon-merge-a', traits: { email: 'merge-caps@example.com' } });
    await mergedInto(b, a);
    await identify({ userId: 'u-merge-c', traits: { email: 'merge-caps@example.com' } });
    await mergedInto(a, c);

    const { rows } = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ profile_id: string }>(sql`SELECT profile_id FROM messages WHERE workspace_id = ${ws} AND id = 'msg_460_b'`),
    );
    expect(rows[0]?.profile_id).toBe(c);

    const api = t.api(owner, ws);
    const policy = await api.call('artifacts.create', {
      type: 'delivery_policy',
      name: 'Delivery policy',
      content: { quietHours: [], frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] },
    });
    await api.call('artifacts.requestPublish', { artifactId: policy.artifactId, note: 'caps' });
    policyId = policy.artifactId;

    const check = (id: string) =>
      t.srv.db.withWorkspace(ws, (tx) =>
        checkPolicy(
          tx,
          ws,
          { id, createdAt: new Date(), profileId: c, channel: 'email', purpose: 'marketing_email', basis: 'consent', agentId: 'agt_new' },
          DEFAULT_PURPOSES,
        ),
      );
    // The channel frequency cap sees the message that arrived with the merged profile.
    expect(await check('msg_460_frequency')).toMatchObject({ ok: false, reason: expect.stringContaining('frequency_cap') });

    // The cross-agent contact pressure sees it too, on the same survivor after two merges.
    await api.call('artifacts.updateDraft', {
      artifactId: policyId,
      content: { quietHours: [], frequencyCaps: [] },
    });
    await api.call('artifacts.requestPublish', { artifactId: policyId, note: 'agent caps' });
    expect(await check('msg_460_pressure')).toMatchObject({ ok: false, reason: expect.stringContaining('agent_contact_pressure') });
  }, 90_000);
});
