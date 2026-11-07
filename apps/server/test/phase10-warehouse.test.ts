import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScoped } from '../../../packages/db/test/run';
import { eventually, startTestServer, testPort, type User } from './harness';

// Phase 10 (wave 2), part c: warehouse export. A Postgres warehouse receives pseudonymous data
// incrementally (no personal data in it), snapshots of segment memberships, and erasures; S3-
// compatible storage receives signed uploads of gzipped NDJSON; private addresses are refused.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
const DEST = runScoped('am_test_warehouse_dest');
const destUrl = (process.env.TEST_DATABASE_URL ?? 'postgres://am:am@localhost:5432/am_test')
  .replace(/localhost/, '127.0.0.1')
  .replace(/\/[^/]+$/, `/${DEST}`);
let dest: pg.Client;
let s3: Server;
const puts: { key: string; auth: string; rows: Record<string, unknown>[] }[] = [];

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

beforeAll(async () => {
  const maint = new pg.Client({ connectionString: destUrl.replace(`/${DEST}`, '/postgres') });
  await maint.connect();
  await maint.query(`DROP DATABASE IF EXISTS ${DEST} WITH (FORCE)`);
  await maint.query(`CREATE DATABASE ${DEST}`);
  await maint.end();
  dest = new pg.Client({ connectionString: destUrl });
  await dest.connect();
  s3 = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = gunzipSync(Buffer.concat(chunks)).toString('utf8');
    puts.push({
      key: decodeURIComponent(req.url ?? ''),
      auth: String(req.headers.authorization),
      rows: text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    });
    res.writeHead(200).end();
  });
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));

  // The destination is the test Postgres server, wherever TEST_DATABASE_URL puts it.
  t = await startTestServer('test_p10_wh', testPort(3291), { EGRESS_ALLOWED_HOSTS: `127.0.0.1,${new URL(destUrl).hostname}` });
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
  key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 60_000);
afterAll(async () => {
  await t?.close();
  await dest?.end();
  s3?.close();
});

const exported = async (id: string, after: string | null) =>
  eventually(
    () => t.api(owner).call('warehouse.list', {}),
    (r) => {
      const x = r.exports.find((e) => e.id === id);
      return !!x?.lastRunAt && x.lastRunAt !== after;
    },
    15_000,
  ).then((r) => r.exports.find((e) => e.id === id)!);

describe('warehouse export', () => {
  let profileId = '';
  let exportId = '';

  it('exports profiles, ids, consent, memberships and events to Postgres, without personal data', async () => {
    const api = t.api(owner);
    await send([
      { type: 'identify', userId: 'wh-1', traits: { email: 'secret-person@example.com', plan: 'pro' } },
      {
        type: 'track',
        event: 'Order Completed',
        userId: 'wh-1',
        properties: { total: 42, email: 'buyer@example.com', name: 'Buyer Name', address: '1 Main Street' },
      },
      {
        type: 'track',
        event: 'Segment Consent Preference Updated',
        userId: 'wh-1',
        context: { consent: { categoryPreferences: { marketing_email: true } } },
      },
    ]);
    profileId = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: 'wh-1' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    const seg = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Pro',
      content: { condition: { trait: 'plan', op: 'eq', value: 'pro' } },
    });
    await api.call('artifacts.requestPublish', { artifactId: seg.artifactId, note: 'x' });
    await api.call('segments.refresh', { artifactId: seg.artifactId });
    // Events reach ClickHouse through the sink; the export reads what is stored.
    await eventually(
      () => api.call('profiles.events', { profileId }),
      (r) => r.events.length >= 2,
    );

    const x = await api.call('warehouse.create', { name: 'Analytics DB', kind: 'postgres', secrets: { url: destUrl } });
    exportId = x.id;
    const done = await exported(x.id, null);
    expect(done).toMatchObject({ lastStatus: 'ok', lastError: null });
    expect(done.lastCounts).toMatchObject({ profiles: 1, identifiers: 1, segment_memberships: 1 });

    const q = async (table: string) => (await dest.query(`SELECT * FROM agentic_marketing.${table} WHERE workspace_id = $1`, [ws])).rows;
    expect((await q('am_profiles'))[0]).toMatchObject({ profile_id: profileId, traits: { plan: 'pro' } });
    expect((await q('am_identifiers')).map((r) => r.value)).toEqual(['wh-1']);
    expect((await q('am_consent')).find((r) => r.purpose === 'marketing_email')).toMatchObject({ status: 'granted' });
    expect((await q('am_segment_memberships'))[0]).toMatchObject({ segment_id: seg.artifactId, profile_id: profileId });
    const events = await q('am_events');
    const orderEvent = events.find((e) => e.name === 'Order Completed')!;
    expect(orderEvent).toMatchObject({ user_id: 'wh-1' });
    expect(orderEvent.properties).toEqual({ total: 42 });
    const everything = JSON.stringify(await Promise.all(['am_profiles', 'am_identifiers', 'am_consent', 'am_events'].map(q)));
    expect(everything).not.toContain('secret-person@example.com');
    expect(everything).not.toContain('buyer@example.com');
    expect(everything).not.toContain('1 Main Street');
  });

  it('adds what changed on the next run, replaces membership snapshots, and applies erasures', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'wh-1', traits: { plan: 'free' } }]);
    await eventually(
      () => api.call('profiles.get', { profileId }),
      (p) => p.traits.plan === 'free',
    );
    const before = (await api.call('warehouse.list', {})).exports[0].lastRunAt;
    await api.call('warehouse.run', { id: exportId });
    const second = await exported(exportId, before);
    expect(second.lastCounts).toMatchObject({ profiles: 1, identifiers: 0, segment_memberships: 0 });
    expect((await dest.query('SELECT traits FROM agentic_marketing.am_profiles WHERE workspace_id = $1', [ws])).rows[0].traits).toEqual({
      plan: 'free',
    });
    expect(
      (await dest.query('SELECT count(*)::int AS n FROM agentic_marketing.am_segment_memberships WHERE workspace_id = $1', [ws])).rows[0].n,
    ).toBe(0);

    await api.call('profiles.erase', { profileId, reason: 'Erasure request, test' });
    await api.call('warehouse.run', { id: exportId });
    const third = await exported(exportId, second.lastRunAt);
    expect(third.lastCounts.erasures).toBe(1);
    for (const table of ['am_profiles', 'am_identifiers', 'am_consent', 'am_events'])
      expect(
        (await dest.query(`SELECT count(*)::int AS n FROM agentic_marketing.${table} WHERE workspace_id = $1`, [ws])).rows[0].n,
        table,
      ).toBe(0);
    expect(
      (await dest.query('SELECT profile_ids FROM agentic_marketing.am_erasures WHERE workspace_id = $1', [ws])).rows[0].profile_ids,
    ).toContain(profileId);
  });

  it('writes signed, gzipped NDJSON to S3-compatible storage', async () => {
    const api = t.api(owner);
    await send([{ type: 'track', event: 'Page Viewed', anonymousId: 'anon-s3' }]);
    await eventually(
      () => api.call('profiles.find', { type: 'anonymous_id', value: 'anon-s3' }),
      (r) => !!r.profileId,
    );
    await new Promise((r) => setTimeout(r, 1500)); // the sink stores the event
    const endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
    const x = await api.call('warehouse.create', {
      name: 'Lake',
      kind: 's3',
      config: { bucket: 'lake', region: 'eu-north-1', endpoint, prefix: 'am' },
      secrets: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
      datasets: ['events', 'segment_memberships'],
    });
    expect(await exported(x.id, null)).toMatchObject({ lastStatus: 'ok' });
    expect(puts.every((p) => /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-north-1\/s3\/aws4_request/.test(p.auth))).toBe(true);
    const events = puts.find((p) => p.key.startsWith(`/lake/am/workspace=${ws}/events/dt=`));
    expect(events?.rows.some((r) => r.name === 'Page Viewed' && r.anonymous_id === 'anon-s3')).toBe(true);
    expect(puts.some((p) => /segment_memberships\/snapshot=[^/]+\/_complete\.ndjson\.gz$/.test(p.key))).toBe(true);
  });

  it('refuses a destination on a private address', async () => {
    const api = t.api(owner);
    const x = await api.call('warehouse.create', {
      name: 'Internal',
      kind: 'postgres',
      secrets: { url: 'postgres://u:p@10.0.0.1:5432/x' },
      datasets: ['profiles'],
    });
    const done = await exported(x.id, null);
    expect(done).toMatchObject({ lastStatus: 'failed' });
    expect(done.lastError).toContain('private address');
  });

  // #373: an events-only destination does not receive am_identifiers, so erasure used to delete
  // nothing and still record success in am_erasures.
  it('erases events for a destination that exports only events', async () => {
    const api = t.api(owner);
    const userId = `wh-events-only-${Date.now()}`;
    await send([
      { type: 'identify', userId, traits: { plan: 'events' } },
      { type: 'track', event: 'Viewed', userId, properties: { page: 'pricing' } },
    ]);
    const profileId = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: userId }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    await eventually(
      () => api.call('profiles.events', { profileId }),
      (r) => r.events.length >= 1,
    );
    await new Promise((r) => setTimeout(r, 1500)); // the sink stores the event

    const x = await api.call('warehouse.create', {
      name: 'Events only',
      kind: 'postgres',
      config: { schema: 'events_only' },
      secrets: { url: destUrl },
      datasets: ['events'],
    });
    expect(await exported(x.id, null)).toMatchObject({ lastStatus: 'ok' });

    const events = async () =>
      (await dest.query('SELECT count(*)::int AS n FROM events_only.am_events WHERE workspace_id = $1 AND user_id = $2', [ws, userId]))
        .rows[0].n as number;
    expect(await events()).toBeGreaterThanOrEqual(1);
    expect(
      (
        await dest.query(
          "SELECT count(*)::int AS n FROM events_only.am_events WHERE workspace_id = $1 AND user_id = $2 AND name = 'Viewed'",
          [ws, userId],
        )
      ).rows[0].n,
    ).toBe(1);
    // It never received the identifiers dataset.
    expect((await dest.query('SELECT count(*)::int AS n FROM events_only.am_identifiers WHERE workspace_id = $1', [ws])).rows[0].n).toBe(0);

    await api.call('profiles.erase', { profileId, reason: 'Erasure request, events-only test' });
    await api.call('warehouse.run', { id: x.id });
    expect(await eventually(events, (n) => n === 0)).toBe(0);
    const recorded = await eventually(
      async () =>
        (
          await dest.query('SELECT applied, uncovered FROM events_only.am_erasures WHERE workspace_id = $1 AND $2 = ANY(profile_ids)', [
            ws,
            profileId,
          ])
        ).rows[0],
      (r) => !!r,
    );
    expect(recorded).toMatchObject({ applied: true, uncovered: null });
  });

  // #374: a merge re-points identifiers without touching first_seen, and the surviving consent
  // row is materialised with the winning ledger record's (older) time. Both must be re-exported.
  it('re-exports identifiers re-pointed by a merge and consent rewritten with an older time', async () => {
    const api = t.api(owner);
    const anon = `wh-merge-anon-${Date.now()}`;
    const user = `wh-merge-user-${Date.now()}`;
    // The resolver keeps the oldest profile, regardless of identifier strength. Wait for the
    // intended survivor to exist before sending the other identity: different shard workers
    // may otherwise apply these two identifies in either order.
    await send([{ type: 'identify', userId: user, traits: { plan: 'survivor' } }]);
    const into = (
      await eventually(
        () => api.call('profiles.find', { type: 'user_id', value: user }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    expect(into).toBeTruthy();
    await send([{ type: 'identify', anonymousId: anon, traits: { plan: 'merged' } }]);
    const from = (
      await eventually(
        () => api.call('profiles.find', { type: 'anonymous_id', value: anon }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    expect(from).toBeTruthy();

    // A withdrew ad_targeting five days ago; B granted it ten days ago. The recomputed survivor
    // row keeps the newer ledger time (five days ago) and status withdrawn.
    await api.call('consent.record', { profileId: from, purpose: 'ad_targeting', status: 'withdrawn', source: 'api' });
    await t.srv.db.admin.query(
      `UPDATE consent_records SET recorded_at = now() - interval '5 days'
       WHERE workspace_id = $1 AND profile_id = $2 AND purpose = 'ad_targeting'`,
      [ws, from],
    );
    // A further record recomputes consent_state, so the withdrawal's old recorded_at becomes
    // the materialised updated_at.
    await api.call('consent.record', { profileId: from, purpose: 'marketing_email', status: 'granted', source: 'api' });
    await api.call('consent.record', { profileId: into, purpose: 'ad_targeting', status: 'granted', source: 'api' });
    await t.srv.db.admin.query(
      `UPDATE consent_records SET recorded_at = now() - interval '10 days'
       WHERE workspace_id = $1 AND profile_id = $2 AND purpose = 'ad_targeting'`,
      [ws, into],
    );
    await api.call('consent.record', { profileId: into, purpose: 'marketing_email', status: 'granted', source: 'api' });

    const beforeMerge = (await api.call('warehouse.list', {})).exports.find((e) => e.id === exportId)!.lastRunAt;
    await api.call('warehouse.run', { id: exportId });
    await exported(exportId, beforeMerge);
    expect(
      await eventually(
        async () =>
          (
            await dest.query(
              'SELECT status FROM agentic_marketing.am_consent WHERE workspace_id = $1 AND profile_id = $2 AND purpose = $3',
              [ws, into, 'ad_targeting'],
            )
          ).rows[0]?.status,
        (s) => s === 'granted',
      ),
    ).toBe('granted');

    // Merging the anonymous profile into the user profile re-points the identifier and rewrites
    // the survivor's consent state, both with timestamps older than the export cursor.
    await send([{ type: 'alias', previousId: anon, userId: user }]);
    expect(
      (
        await eventually(
          () => api.call('profiles.find', { type: 'anonymous_id', value: anon }),
          (r) => r.profileId === into,
        )
      ).profileId,
    ).toBe(into);

    await api.call('warehouse.run', { id: exportId });
    const identifiers = await eventually(
      async () =>
        (
          await dest.query('SELECT value, profile_id FROM agentic_marketing.am_identifiers WHERE workspace_id = $1 AND value IN ($2, $3)', [
            ws,
            anon,
            user,
          ])
        ).rows,
      (rows) => rows.length === 2 && rows.every((r) => r.profile_id === into),
    );
    expect(identifiers).toHaveLength(2);
    expect(identifiers.every((r) => r.profile_id === into)).toBe(true);
    const consent = await eventually(
      async () =>
        (
          await dest.query(
            'SELECT status, updated_at FROM agentic_marketing.am_consent WHERE workspace_id = $1 AND profile_id = $2 AND purpose = $3',
            [ws, into, 'ad_targeting'],
          )
        ).rows[0],
      (r) => r?.status === 'withdrawn',
    );
    expect(consent.status).toBe('withdrawn');
    expect(Date.now() - new Date(consent.updated_at).getTime()).toBeGreaterThan(4 * 86_400_000);
  }, 60_000);
});
