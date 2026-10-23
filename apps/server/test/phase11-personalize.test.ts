import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import worker from '@agentic-marketing/edge-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

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
const kv = new Map<string, unknown>();
const calls: { method: string; path: string; auth: string }[] = [];
const ACCOUNT = 'a'.repeat(32);
const NS = 'b'.repeat(32);
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
const edgeEnv = { AM_KV: { get: async (k: string) => kv.get(k) ?? null }, AM_CACHE_SECONDS: '0' };
const edgeDecide = async (body: Record<string, unknown>) => {
  const res = await worker.fetch(
    new Request('https://shop.example.com/am/v1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://shop.example.com' },
      body: JSON.stringify({ writeKey: key, placements: ['home_hero'], ...body }),
    }),
    edgeEnv,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { personalized: boolean; decisions: { experienceId: string; variantId: string }[] };
};

beforeAll(async () => {
  cf = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]');
    const path = (req.url ?? '').replace(`/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}`, '');
    calls.push({ method: req.method ?? '', path, auth: String(req.headers.authorization) });
    if (path === '/bulk' && req.method === 'PUT') for (const e of body) kv.set(e.key, JSON.parse(e.value));
    else if (path === '/bulk/delete' && req.method === 'POST') for (const k of body) kv.delete(k);
    else
      return res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: false, errors: [{ message: 'no' }] }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, errors: [] }));
  });
  await new Promise<void>((r) => cf.listen(0, '127.0.0.1', r));
  cfBase = `http://127.0.0.1:${(cf.address() as AddressInfo).port}`;

  t = await startTestServer('test_p11_pers', 3294);
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
});
