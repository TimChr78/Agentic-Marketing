import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #615: deliveries.list used to return one capped, mixed-kind page. A workspace with busy action
// or ad-conversion deliveries then starved the webhooks card, which saw zero webhook rows and
// showed "Never" for endpoints that had delivered. The kind filter must run in the query, before
// the limit, so the cap applies to the kind the caller asked for.

const PORT = testPort(3532);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const WEBHOOK_DELIVERY = 'dlv_00000000000000000000000000006150';

beforeAll(async () => {
  t = await startTestServer('test_delivery_kind', PORT);
  owner = await t.signUp(`deliveries-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  const endpoint = await api.call('webhooks.create', { name: 'Orders', url: 'https://example.com/hook', events: ['*'] });

  // One real webhook delivery, older than the flood so the mixed, newest-first page cannot reach it.
  await t.srv.db.admin.query(
    `INSERT INTO deliveries (workspace_id, id, kind, target_id, payload, status, attempts, idempotency_key, created_at)
     VALUES ($1, $2, 'webhook', $3, '{}'::jsonb, 'failed', 2, '615-webhook', now() - interval '2 hours')`,
    [ws, WEBHOOK_DELIVERY, endpoint.id],
  );
  // 120 newer action deliveries: more than the 100-row cap the card asks for.
  await t.srv.db.admin.query(
    `INSERT INTO deliveries (workspace_id, id, kind, target_id, action, payload, status, idempotency_key, created_at)
     SELECT $1, 'dlv_action_' || g, 'action', 'con_flood', 'postMessage', '{}'::jsonb, 'done', '615-action-' || g,
            now() - interval '1 hour' + (g || ' seconds')::interval
     FROM generate_series(1, 120) AS g`,
    [ws],
  );
}, 60_000);
afterAll(() => t?.close());

describe('deliveries.list kind filter (#615)', () => {
  it('returns webhook deliveries even when 100 newer non-webhook deliveries exist', async () => {
    const api = t.api(owner);

    // The starvation the card hit: the unfiltered, 100-row page holds no webhook delivery at all.
    const mixed = await api.call('deliveries.list', { limit: 100 });
    expect(mixed.deliveries).toHaveLength(100);
    expect(mixed.deliveries.some((d) => d.kind === 'webhook')).toBe(false);

    const webhooks = await api.call('deliveries.list', { kind: 'webhook' });
    expect(webhooks.deliveries.map((d) => d.id)).toEqual([WEBHOOK_DELIVERY]);
    expect(webhooks.deliveries[0]).toMatchObject({ kind: 'webhook', status: 'failed', targetId: expect.any(String) });

    // The per-endpoint read used for "Last delivery" narrows by targetId too.
    const perEndpoint = await api.call('deliveries.list', { kind: 'webhook', targetId: webhooks.deliveries[0]!.targetId });
    expect(perEndpoint.deliveries.map((d) => d.id)).toEqual([WEBHOOK_DELIVERY]);

    // A kind no row has is empty, not the mixed page.
    expect((await api.call('deliveries.list', { kind: 'ad_conversion' })).deliveries).toEqual([]);
  });
});
