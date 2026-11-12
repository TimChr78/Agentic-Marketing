import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import worker from '@agentic-marketing/edge-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 11 (wave 2), part c: personalization. Experiences, write keys and profile snapshots are
// mirrored to Cloudflare Workers KV (a fake Cloudflare API here), where the edge worker decides
// like the server does; erasure reaches the edge; preview links force a variant; results carry
// the analysis method the experience asks for.

let t: Awaited<ReturnType<typeof startTestServer>>;
let cf: Server;
let cfBase = '';
let owner: User;
let ws = '';
let key = '';
let segment = '';
let hero = '';
const stores = new Map<string, Map<string, unknown>>();
const store = (account: string, ns: string) => {
  const id = `${account}/${ns}`;
  const found = stores.get(id);
  if (found) return found;
  const created = new Map<string, unknown>();
  stores.set(id, created);
  return created;
};
const ACCOUNT = 'a'.repeat(32);
const NS = 'b'.repeat(32);
const kv = store(ACCOUNT, NS);
const kvOf = (ns: string, account = ACCOUNT) => store(account, ns);
/** Deletions fail while this is set, to prove a cleanup is not marked complete and tombstones are retried. */
let failDeletes = false;
const forbiddenNamespaces = new Set<string>();
const calls: { method: string; path: string; auth: string }[] = [];
const yes = { consent: { categoryPreferences: { analytics: true, web_personalization: true } } };

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://shop.example.com',
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch }),
  });
const edgeEnvFor = (s: Map<string, unknown>) => ({
  AM_KV: { get: async (k: string) => s.get(k) ?? null },
  AM_CACHE_SECONDS: '0',
});
const edgeEnv = edgeEnvFor(kv);
const edgeDecide = async (body: Record<string, unknown>, env = edgeEnv) => {
  const res = await worker.fetch(
    new Request('https://shop.example.com/am/v1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://shop.example.com' },
      body: JSON.stringify({ writeKey: key, placements: ['home_hero'], ...body }),
    }),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { personalized: boolean; decisions: { experienceId: string; variantId: string }[] };
};

beforeAll(async () => {
  cf = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)(\/[^?]*)$/);
    if (!m)
      return res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: false, errors: [{ message: 'no' }] }));
    if (forbiddenNamespaces.has(m[2]))
      return res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: false, errors: [{ message: 'token cannot access the old namespace' }] }));
    const target = store(m[1], m[2]);
    const path = m[3];
    calls.push({ method: req.method ?? '', path, auth: String(req.headers.authorization) });
    if (path === '/bulk' && req.method === 'PUT') for (const e of body) target.set(e.key, JSON.parse(e.value));
    else if (path === '/bulk/delete' && req.method === 'POST') {
      if (failDeletes)
        return res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ success: false, errors: [{ message: 'KV unavailable' }] }));
      for (const k of body) target.delete(k);
    } else if (path === '/keys' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const names = [...target.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, errors: [], result: names.map((name) => ({ name })), result_info: { count: names.length } }));
    } else
      return res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: false, errors: [{ message: 'no' }] }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, errors: [] }));
  });
  await new Promise<void>((r) => cf.listen(0, '127.0.0.1', r));
  cfBase = `http://127.0.0.1:${(cf.address() as AddressInfo).port}`;

  t = await startTestServer('test_p11_pers', testPort(3294));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  key = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: ['https://shop.example.com'] })).key;
  const publish = async (type: 'segment' | 'experience', name: string, content: unknown) => {
    const a = await api.call('artifacts.create', { type, name, content: content as Record<string, unknown> });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
    return a.artifactId;
  };
  segment = await publish('segment', 'Gold', { condition: { trait: 'tier', op: 'eq', value: 'gold' } });
  hero = await publish('experience', 'Gold hero', {
    placement: 'home_hero',
    targeting: { segment },
    variants: [
      { id: 'a', name: 'Plain', weight: 50, content: { html: '<h1>Welcome back</h1>' } },
      { id: 'b', name: 'Offer', weight: 50, content: { html: '<h1>Gold offer</h1>' } },
    ],
    goal: { event: 'Order Completed' },
    analysis: { method: 'bayesian', threshold: 0.9 },
  });
  // Someone already known before the edge is turned on: the backfill brings them there.
  await send([{ type: 'identify', userId: 'u-early', traits: { tier: 'gold' }, context: yes }]);
  const early = await eventually(
    () => api.call('profiles.find', { type: 'user_id', value: 'u-early' }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => api.call('segments.ofProfile', { profileId: early.profileId! }),
    (r) => r.segments.some((s) => s.id === segment),
  );
}, 60_000);
afterAll(async () => {
  await t?.close();
  cf?.close();
});

describe('edge decisions', () => {
  it('needs a token the first time, and never shows it again', async () => {
    expect(
      (await rejects(t.api(owner).call('edge.configure', { accountId: ACCOUNT, namespaceId: NS, apiBase: cfBase }))).message,
    ).toContain('apiToken');
    const s = await t.api(owner).call('edge.configure', {
      accountId: ACCOUNT,
      namespaceId: NS,
      apiToken: 'cf-token-0123456789abcdef',
      apiBase: cfBase,
      enabled: true,
    });
    expect(s).toMatchObject({ configured: true, enabled: true, hasToken: true, snapshots: true });
    expect(JSON.stringify(s)).not.toContain('cf-token');
  });

  it('mirrors experiences and write keys, and the worker decides from them', async () => {
    await eventually(
      async () => kv.get(`am:exp:${ws}`) as { experiences: { id: string }[] } | undefined,
      (b) => !!b?.experiences.some((e) => e.id === hero),
    );
    expect(calls.every((c) => c.auth === 'Bearer cf-token-0123456789abcdef')).toBe(true);
    // Not in the segment (no snapshot at the edge): nothing for the hero.
    expect((await edgeDecide({ userId: 'nobody', context: yes })).decisions).toEqual([]);
    // The sync records its time after the writes it made.
    const status = await eventually(
      () => t.api(owner).call('edge.status', {}),
      (s) => s.lastSyncAt !== null,
    );
    expect(status.lastError).toBeNull();
    expect(status.lastSyncAt).not.toBeNull();
  });

  it('mirrors snapshots of people active since, and deletes them on erasure', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'u-gold', traits: { tier: 'gold' }, context: yes }]);
    await eventually(
      async () => kv.get(`am:snap:${ws}:u:u-gold`) as { segments: string[] } | undefined,
      (s) => !!s?.segments.includes(segment),
    );
    const d = await edgeDecide({ userId: 'u-gold', context: yes });
    expect(d).toMatchObject({ personalized: true, decisions: [{ experienceId: hero }] });
    // Without consent, the edge does not use the snapshot either.
    expect((await edgeDecide({ userId: 'u-gold' })).decisions).toEqual([]);

    const { profileId } = await api.call('profiles.find', { type: 'user_id', value: 'u-gold' });
    await api.call('profiles.erase', { profileId: profileId!, reason: 'Erasure request (test)' });
    await eventually(
      async () => kv.has(`am:snap:${ws}:u:u-gold`),
      (has) => !has,
    );
  });

  it('backfills people known before, at the start and on request', async () => {
    await eventually(
      async () => kv.get(`am:snap:${ws}:u:u-early`) as { segments: string[] } | undefined,
      (s) => !!s?.segments.includes(segment),
    );
    kv.delete(`am:snap:${ws}:u:u-early`);
    await t.api(owner).call('edge.sync', { backfillSnapshots: true });
    await eventually(
      async () => kv.get(`am:snap:${ws}:u:u-early`) as { segments: string[] } | undefined,
      (s) => !!s?.segments.includes(segment),
    );
    await eventually(
      () => t.api(owner).call('edge.status', {}),
      (s) => !s.backfilling,
    );
  });

  it('removes write keys that are gone', async () => {
    const api = t.api(owner);
    const other = await api.call('sources.create', { name: 'Other', kind: 'server' });
    const before = kv.size;
    await eventually(
      async () => kv.size,
      (n) => n > before,
    );
    await api.call('sources.delete', { id: other.id });
    await eventually(
      async () => [...kv.entries()].filter(([k, v]) => k.startsWith('am:key:') && (v as { enabled: boolean }).enabled).length,
      (n) => n === 1,
    );
  });
});

describe('edge cleanup and destination changes', () => {
  it('removes the bundle, write keys and snapshots when mirroring is turned off', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'u-off', traits: { tier: 'gold' }, context: yes }]);
    await eventually(
      async () => kv.get(`am:snap:${ws}:u:u-off`),
      (s) => !!s,
    );
    const off = await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: NS, apiBase: cfBase, enabled: false });
    expect(off).toMatchObject({ enabled: false, cleanup: 'all', backfilling: false });
    await eventually(
      async () => [...kv.keys()].filter((k) => k.startsWith(`am:snap:${ws}:`)).length,
      (n) => n === 0,
    );
    await eventually(
      async () =>
        [...kv.entries()].filter(
          ([k, v]) => k === `am:exp:${ws}` || (k.startsWith('am:key:') && (v as { workspaceId: string }).workspaceId === ws),
        ).length,
      (n) => n === 0,
    );
    const st = await eventually(
      () => api.call('edge.status', {}),
      (s) => s.cleanup === null && s.lastError === null,
    );
    expect(st).toMatchObject({ cleanup: null, pendingDeletes: 0, staleTargets: [] });
    // The worker no longer accepts the write key: the edge endpoint is revoked, not just paused.
    const res = await worker.fetch(
      new Request('https://shop.example.com/am/v1/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://shop.example.com' },
        body: JSON.stringify({ writeKey: key, placements: ['home_hero'] }),
      }),
      edgeEnv,
    );
    expect(res.status).toBe(401);
    // With no serving copy left, a later erasure has nothing to queue.
    const { profileId } = await api.call('profiles.find', { type: 'user_id', value: 'u-off' });
    await api.call('profiles.erase', { profileId: profileId!, reason: 'Erasure request (test)' });
    expect(await api.call('edge.status', {})).toMatchObject({ cleanup: null, pendingDeletes: 0 });
  });

  it('removes people but keeps page targeting when only snapshots are turned off', async () => {
    const api = t.api(owner);
    const on = await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: NS, apiBase: cfBase, enabled: true });
    expect(on).toMatchObject({ enabled: true, snapshots: true, backfilling: true });
    await eventually(
      async () => kv.get(`am:exp:${ws}`),
      (b) => !!b,
    );
    await eventually(
      async () => kv.get(`am:snap:${ws}:u:u-early`),
      (s) => !!s,
    );
    const off = await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: NS, apiBase: cfBase, snapshots: false });
    expect(off).toMatchObject({ snapshots: false, cleanup: 'snapshots' });
    await eventually(
      async () => [...kv.keys()].filter((k) => k.startsWith(`am:snap:${ws}:`)).length,
      (n) => n === 0,
    );
    // Experiences and write keys stay: page, referrer, UTM and device targeting still work.
    expect(kv.has(`am:exp:${ws}`)).toBe(true);
    const st = await eventually(
      () => api.call('edge.status', {}),
      (s) => s.cleanup === null && s.lastError === null,
    );
    expect(st.cleanup).toBeNull();
    // And nothing about a person is written while snapshots are off.
    await send([{ type: 'identify', userId: 'u-silent', traits: { tier: 'gold' }, context: yes }]);
    const found = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'u-silent' }),
      (r) => !!r.profileId,
    );
    expect(found.profileId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2500));
    expect(kv.has(`am:snap:${ws}:u:u-silent`)).toBe(false);
  });

  it('restarts the backfill when the destination changes, and removes the old copies', async () => {
    const api = t.api(owner);
    await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: NS, apiBase: cfBase, snapshots: true });
    await eventually(
      () => api.call('edge.status', {}),
      (s) => !s.backfilling && s.cleanup === null,
    );
    // Rotating only the token keeps the finished backfill and the pushed bundle.
    const rotated = await api.call('edge.configure', {
      accountId: ACCOUNT,
      namespaceId: NS,
      apiBase: cfBase,
      apiToken: 'cf-token-rotated-0123456789abcdef',
    });
    expect(rotated.backfilling).toBe(false);

    const NS2 = 'd'.repeat(32);
    const moved = await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: NS2, apiBase: cfBase });
    expect(moved).toMatchObject({ namespaceId: NS2, backfilling: true, cleanup: 'all' });
    const next = kvOf(NS2);
    await eventually(
      async () => next.get(`am:exp:${ws}`),
      (b) => !!b,
    );
    // The new namespace gets the people known before, not only those active since.
    await eventually(
      async () => next.get(`am:snap:${ws}:u:u-early`),
      (s) => !!s,
    );
    // The old namespace no longer serves anything for this workspace.
    await eventually(
      async () => [...kv.keys()].filter((k) => k.startsWith(`am:snap:${ws}:`) || k === `am:exp:${ws}` || k.startsWith('am:key:')).length,
      (n) => n === 0,
    );
    const st = await eventually(
      () => api.call('edge.status', {}),
      (s) => s.namespaceId === NS2 && s.staleTargets.length === 0 && !s.backfilling && s.lastError === null,
    );
    expect(st.staleTargets).toEqual([]);
    expect((await edgeDecide({ userId: 'u-early', context: yes }, edgeEnvFor(next))).decisions).toMatchObject([{ experienceId: hero }]);
  });

  it('keeps a cleanup owed and retries when deletion fails, and never drops erasure tombstones', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'u-keep', traits: { tier: 'gold' }, context: yes }]);
    await eventually(
      async () => kvOf('d'.repeat(32)).get(`am:snap:${ws}:u:u-keep`),
      (s) => !!s,
    );
    failDeletes = true;
    const off = await api.call('edge.configure', {
      accountId: ACCOUNT,
      namespaceId: 'd'.repeat(32),
      apiBase: cfBase,
      enabled: false,
    });
    expect(off.cleanup).toBe('all');
    const failed = await eventually(
      () => api.call('edge.status', {}),
      (s) => s.lastError !== null,
      15_000,
    );
    // A failed remote deletion is reported, not treated as a finished cleanup.
    expect(failed.cleanup).toBe('all');
    expect(failed.lastError).toContain('KV unavailable');

    const { profileId } = await api.call('profiles.find', { type: 'user_id', value: 'u-keep' });
    await api.call('profiles.erase', { profileId: profileId!, reason: 'Erasure request (test)' });
    const pending = await eventually(
      () => api.call('edge.status', {}),
      (s) => s.pendingDeletes > 0,
      10_000,
    );
    expect(pending.pendingDeletes).toBeGreaterThan(0);

    failDeletes = false;
    const done = await eventually(
      () => api.call('edge.status', {}),
      (s) => s.cleanup === null && s.pendingDeletes === 0 && s.lastError === null,
      20_000,
    );
    expect(done.cleanup).toBeNull();
    expect(done.pendingDeletes).toBe(0);
  });
  it('keeps an old-target cleanup error visible while the new target syncs successfully', async () => {
    const api = t.api(owner);
    const oldNs = 'd'.repeat(32);
    const nextNs = 'e'.repeat(32);
    await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: oldNs, apiBase: cfBase, enabled: true });
    await eventually(
      () => api.call('edge.status', {}),
      (r) => !r.backfilling && !r.cleanup && !r.lastError,
    );
    forbiddenNamespaces.add(oldNs);
    try {
      await api.call('edge.configure', { accountId: ACCOUNT, namespaceId: nextNs, apiBase: cfBase });
      const failed = await eventually(
        () => api.call('edge.status', {}),
        (r) => r.namespaceId === nextNs && r.staleTargets.length === 1 && !r.backfilling && !!r.lastError,
      );
      expect(kvOf(nextNs).has(`am:exp:${ws}`)).toBe(true);
      expect(failed.lastError).toContain('prior edge destination');
      expect(failed.staleTargets[0].lastError).toContain('403');
      // Force another successful current-target sync during old-target retry backoff.
      await api.call('edge.sync', {});
      const again = await eventually(
        () => api.call('edge.status', {}),
        (r) => r.lastSyncAt !== failed.lastSyncAt,
      );
      expect(again.lastError).toContain('prior edge destination');
    } finally {
      forbiddenNamespaces.delete(oldNs);
      await t.srv.db.admin.query(
        `UPDATE edge_targets SET prior_target = jsonb_set(prior_target, '{0,nextAttemptAt}', '"1970-01-01T00:00:00Z"') WHERE workspace_id = $1`,
        [ws],
      );
    }
    await eventually(
      () => api.call('edge.status', {}),
      (r) => r.staleTargets.length === 0 && r.lastError === null,
    );
  });
});

describe('preview and results', () => {
  it('previews a variant on the server, ignoring targeting', async () => {
    const res = await fetch(`${t.base}/v1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://shop.example.com' },
      body: JSON.stringify({
        writeKey: key,
        anonymousId: 'anon-p',
        placements: ['home_hero'],
        preview: { experienceId: hero, variantId: 'b' },
      }),
    });
    expect(await res.json()).toMatchObject({
      decisions: [{ experienceId: hero, variantId: 'b', content: { html: '<h1>Gold offer</h1>' } }],
    });
  });

  it('reports the analysis method the experience asks for', async () => {
    const r = await t.api(owner).call('experiences.results', { artifactId: hero });
    expect(r.method).toBe('bayesian');
  });

  it('reads the published version, so editing a draft does not rewrite a live experiment’s results (#631)', async () => {
    const api = t.api(owner);
    const before = await api.call('experiences.results', { artifactId: hero });
    expect(before).toMatchObject({ method: 'bayesian', goal: 'Order Completed', version: 1 });

    // A draft that drops the goal, swaps the control variant and changes the analysis method.
    await api.call('artifacts.updateDraft', {
      artifactId: hero,
      content: {
        placement: 'home_hero',
        variants: [{ id: 'b', name: 'Offer', weight: 100, content: { html: '<h1>Draft offer</h1>' } }],
        analysis: { method: 'fixed' },
      },
    });
    const artifact = await api.call('artifacts.get', { artifactId: hero });
    expect(artifact.latestVersion).toBeGreaterThan(artifact.publishedVersion!);

    const after = await api.call('experiences.results', { artifactId: hero });
    expect(after.version).toBe(artifact.publishedVersion);
    expect(after.method).toBe('bayesian');
    expect(after.goal).toBe('Order Completed');
    expect(after.recommendation).not.toContain('Set a goal event');
  });

  it('counts only exposures of the version the results describe, after a republish (#758)', async () => {
    const api = t.api(owner);
    const publishVersion = async (artifactId: string, content: Record<string, unknown>) => {
      await api.call('artifacts.updateDraft', { artifactId, content });
      await api.call('artifacts.requestPublish', { artifactId, note: 'republish for #758' });
    };
    const v1 = {
      placement: 'versioned_hero',
      variants: [
        { id: 'a', name: 'Plain', weight: 50, content: { html: '<h1>Plain</h1>' } },
        { id: 'b', name: 'Offer', weight: 50, content: { html: '<h1>Offer</h1>' } },
      ],
      goal: { event: 'Order Completed' },
      analysis: { method: 'sequential', alpha: 0.05 },
    };
    const created = await api.call('artifacts.create', { type: 'experience', name: 'Versioned hero', content: v1 });
    await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'first version' });
    const exp = created.artifactId;
    const viewed = (anonymousId: string, variant: string, version: number) => ({
      type: 'track',
      event: 'Experience Viewed',
      anonymousId,
      properties: { experience_id: exp, variant_id: variant, version, placement: 'versioned_hero' },
      context: yes,
      timestamp: '2026-11-10T09:00:00Z',
    });
    const order = (anonymousId: string, at: string) => ({
      type: 'track',
      event: 'Order Completed',
      anonymousId,
      context: yes,
      timestamp: at,
    });
    // Three v1 "a" visitors and two v1 "b" visitors: ids the republished version no longer has.
    await send([...['a0', 'a1', 'a2'].map((v) => viewed(`ver-${v}`, 'a', 1)), ...['b0', 'b1'].map((v) => viewed(`ver-${v}`, 'b', 1))]);

    // Republished with the variants renamed: v2 serves control/treatment, not a/b.
    await publishVersion(exp, {
      ...v1,
      variants: [
        { id: 'control', name: 'Plain', weight: 50, content: { html: '<h1>Plain</h1>' } },
        { id: 'treatment', name: 'Offer', weight: 50, content: { html: '<h1>Offer</h1>' } },
      ],
    });
    await send([
      ...['c0', 'c1'].map((v) => viewed(`ver-${v}`, 'control', 2)),
      viewed('ver-t0', 'treatment', 2),
      viewed('ver-t1', 'treatment', 2),
      order('ver-t0', '2026-11-10T10:00:00Z'),
    ]);
    // ClickHouse is written asynchronously; wait for every exposure before comparing counts.
    await eventually(
      () => t.srv.events.countEvents(ws, { name: 'Experience Viewed' }),
      (rows) => rows.reduce((n, r) => n + r.count, 0) >= 9,
      20_000,
    );

    const r = await api.call('experiences.results', { artifactId: exp });
    expect(r.version).toBe(2);
    expect(r.variants.map((v) => v.variant).sort()).toEqual(['control', 'treatment']);
    expect(r.variants.find((v) => v.variant === 'control')).toMatchObject({ exposed: 2, converted: 0 });
    expect(r.variants.find((v) => v.variant === 'treatment')).toMatchObject({ exposed: 2, converted: 1 });
    expect(r.control).toBe('control');
    expect(r.recommendation).not.toBe('Nothing to compare yet.');
    // The analysis the numbers were computed with, echoed so a draft cannot rewrite the caption.
    expect(r.analysis).toMatchObject({ method: 'sequential', alpha: 0.05, threshold: 0.95 });

    // A version published a moment ago has no exposures of its own: say so instead of showing v1/v2.
    await publishVersion(exp, {
      ...v1,
      variants: [
        { id: 'control', name: 'Plain v3', weight: 50, content: { html: '<h1>Plain v3</h1>' } },
        { id: 'treatment', name: 'Offer v3', weight: 50, content: { html: '<h1>Offer v3</h1>' } },
      ],
    });
    const newest = await api.call('experiences.results', { artifactId: exp });
    expect(newest.version).toBe(3);
    expect(newest.variants).toEqual([]);
    expect(newest.note).toContain('No data for version 3 yet');
  }, 60_000);
});
