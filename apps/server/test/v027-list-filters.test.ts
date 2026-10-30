import { createClient } from '@agentic-marketing/client';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { eventually, startTestServer, testPort, type User } from './harness';

// Phase 14 (#55): server-side filters and aggregates for the People, Messages, Consent, AI usage
// and Deliverability pages. The commands are additive: new optional inputs and output fields.

const PORT = testPort(3461);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';
let readOnly: ReturnType<typeof createClient<Commands>>;
const people = new Map<string, string>();

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

beforeAll(async () => {
  t = await startTestServer('test_v027_list_filters', PORT);
  owner = await t.signUp(`owner-filters-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;

  await send([
    { type: 'identify', userId: 'ada', traits: { email: 'ada@example.com', plan: 'pro' } },
    { type: 'identify', userId: 'bo', traits: { email: 'bo@example.com', plan: 'free' } },
    { type: 'identify', userId: 'cy', traits: { email: 'cy@example.com' } },
  ]);
  for (const [name, email] of [
    ['ada', 'ada@example.com'],
    ['bo', 'bo@example.com'],
    ['cy', 'cy@example.com'],
  ] as const) {
    const found = await eventually(
      () => api.call('profiles.find', { type: 'email', value: email }),
      (r) => !!r.profileId,
    );
    people.set(name, found.profileId!);
  }

  await api.call('consent.record', { profileId: people.get('ada')!, purpose: 'marketing_email', status: 'granted' });
  await api.call('consent.record', { profileId: people.get('ada')!, purpose: 'analytics', status: 'granted' });
  await api.call('consent.record', { profileId: people.get('bo')!, purpose: 'marketing_email', status: 'denied' });
  await api.call('consent.record', {
    profileId: people.get('cy')!,
    purpose: 'marketing_email',
    status: 'granted',
    channel: 'email',
  });

  // A token that may read profiles but not personal data, as an agent would have it.
  const token = await api.call('apiTokens.create', { name: 'read only', scopes: ['profiles:read'] });
  readOnly = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });

  const at = new Date(Date.now() - 60_000);
  const older = (minutes: number) => new Date(at.getTime() - minutes * 60_000);
  const message = (id: string, createdAt: Date, channel: string, status: string, purpose: string) =>
    t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, status, created_at, updated_at)
        VALUES (${ws}, ${id}, ${`idem-${id}`}, ${channel}, ${purpose}, ${status}, ${createdAt}, ${createdAt})`),
    );
  await message('msg_a1', older(1), 'email', 'sent', 'marketing_email');
  await message('msg_a2', at, 'sms', 'failed', 'onboarding');
  // Three rows share a created_at, so only the id tie-breaker keeps the pages apart.
  await message('msg_b1', new Date(at.getTime() + 60_000), 'email', 'sent', 'marketing_email');
  await message('msg_b2', new Date(at.getTime() + 60_000), 'email', 'sent', 'marketing_email');
  await message('msg_b3', new Date(at.getTime() + 60_000), 'email', 'sent', 'marketing_email');

  const ai = (id: string, model: string, inputTokens: number, outputTokens: number) =>
    t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`INSERT INTO ai_calls (workspace_id, id, kind, status, model, input_tokens, output_tokens, created_at)
        VALUES (${ws}, ${id}, 'decide', 'done', ${model}, ${inputTokens}, ${outputTokens}, now())`),
    );
  await ai('aic_known', 'claude-sonnet-4-5', 1_000_000, 1_000_000);
  await ai('aic_unknown', 'mystery-model', 2_000_000, 0);

  await api.call('emailProviders.create', {
    name: 'Secret relay',
    adapter: 'smtp',
    config: { host: 'smtp.secret.example', port: 587, user: 'relay-user' },
    secrets: { password: 'hunter2' },
    fromEmail: 'news@secret.example',
    useFor: ['marketing'],
  });
}, 60_000);

afterAll(() => t?.close());

describe('profiles.list consent summary and e-mail', () => {
  it('returns the current status per purpose for the page', async () => {
    const { profiles } = await t.api(owner, ws).call('profiles.list', { limit: 50 });
    const ada = profiles.find((p) => p.id === people.get('ada'))!;
    expect(ada.consent).toEqual(
      expect.arrayContaining([
        { purpose: 'marketing_email', status: 'granted' },
        { purpose: 'analytics', status: 'granted' },
      ]),
    );
    const bo = profiles.find((p) => p.id === people.get('bo'))!;
    expect(bo.consent.find((c) => c.purpose === 'marketing_email')?.status).toBe('denied');
    // cy only ever granted on the e-mail channel; without a channel that is still a grant (#ADR-0014).
    const cy = profiles.find((p) => p.id === people.get('cy'))!;
    expect(cy.consent.find((c) => c.purpose === 'marketing_email')?.status).toBe('granted');
    // Purposes without a record come back as null, not as a refusal.
    expect(ada.consent.find((c) => c.purpose === 'web_personalization')).toEqual({ purpose: 'web_personalization', status: null });
    expect(ada.email).toBe('ada@example.com');
  });

  it('hides the e-mail without profiles:pii but keeps the consent summary', async () => {
    const { profiles } = await readOnly.call('profiles.list', { limit: 50 });
    const ada = profiles.find((p) => p.id === people.get('ada'))!;
    expect(ada.email).toBeNull();
    expect(ada.consent.find((c) => c.purpose === 'marketing_email')?.status).toBe('granted');
    expect(JSON.stringify(profiles)).not.toContain('ada@example.com');
  });
});

describe('messages.list filters and cursor', () => {
  it('pages newest first by (created_at, id) without overlap', async () => {
    const api = t.api(owner, ws);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const r = await api.call('messages.list', { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...r.messages.map((m) => m.id));
      if (!r.nextCursor) {
        expect(r.nextCursor).toBeNull();
        break;
      }
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(['msg_b3', 'msg_b2', 'msg_b1', 'msg_a2', 'msg_a1']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters on channel, status, purpose and time', async () => {
    const api = t.api(owner, ws);
    const ids = async (input: Record<string, unknown>) =>
      (await api.call('messages.list', { limit: 50, ...input })).messages.map((m) => m.id);
    expect(await ids({ channel: 'sms' })).toEqual(['msg_a2']);
    expect(await ids({ status: 'failed' })).toEqual(['msg_a2']);
    expect((await ids({ purpose: 'marketing_email' })).sort()).toEqual(['msg_a1', 'msg_b1', 'msg_b2', 'msg_b3']);
    const since = new Date(Date.now() - 30_000).toISOString();
    expect((await ids({ since })).sort()).toEqual(['msg_b1', 'msg_b2', 'msg_b3']);
    const until = new Date(Date.now() - 30_000).toISOString();
    expect((await ids({ until })).sort()).toEqual(['msg_a1', 'msg_a2']);
    expect(await ids({ channel: 'email', status: 'failed' })).toEqual([]);
  });

  it('rejects a cursor it did not make', async () => {
    await expect(t.api(owner, ws).call('messages.list', { cursor: 'not-a-cursor' })).rejects.toThrow(/cursor/i);
  });
});

describe('consent.summary', () => {
  it('counts current statuses per purpose and per channel that has records', async () => {
    const { purposes } = await t.api(owner, ws).call('consent.summary', {});
    const marketing = purposes.find((p) => p.purpose === 'marketing_email')!;
    // ada (all channels) and cy (e-mail only) are granted; bo denied.
    expect(marketing).toMatchObject({ granted: 2, denied: 1, withdrawn: 0, objected: 0 });
    expect(marketing.channels).toEqual([{ channel: 'email', granted: 2, denied: 1, withdrawn: 0, objected: 0 }]);
    expect(purposes.find((p) => p.purpose === 'analytics')).toMatchObject({ granted: 1, denied: 0 });
    expect(purposes.find((p) => p.purpose === 'necessary')).toMatchObject({ granted: 0, denied: 0, channels: [] });
  });
});

describe('ai.usage cost and model', () => {
  it('reports the model and an estimated cost, null for an unknown model', async () => {
    const { days } = await t.api(owner, ws).call('ai.usage', { days: 7 });
    const known = days.find((d) => d.model === 'claude-sonnet-4-5')!;
    // $3 input + $15 output per million tokens.
    expect(known).toMatchObject({ kind: 'decide', calls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000, cost: 18 });
    const unknown = days.find((d) => d.model === 'mystery-model')!;
    expect(unknown.cost).toBeNull();
    expect(unknown.inputTokens).toBe(2_000_000);
  });
});

describe('sendingDomains.list', () => {
  it('returns domain checks to a token with only artifacts:read and no provider secrets', async () => {
    const token = await t.api(owner, ws).call('apiTokens.create', { name: 'builder', scopes: ['artifacts:read'] });
    const builder = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
    const r = await builder.call('sendingDomains.list', {});
    expect(r.domains).toHaveLength(1);
    expect(r.domains[0]).toMatchObject({ domain: 'secret.example', uses: ['marketing'] });
    expect(r.domains[0].spf).toHaveProperty('ok');
    expect(r.domains[0].dmarc).toHaveProperty('policy');
    expect(r.domains[0].dkim).toEqual([]);
    const text = JSON.stringify(r);
    for (const hidden of ['epr_', 'Secret relay', 'smtp.secret.example', 'relay-user', 'hunter2', 'news@secret.example']) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe('purposes.list requiresDoubleOptIn', () => {
  it('returns the flag from the defaults and from a published artifact', async () => {
    const api = t.api(owner, ws);
    const defaults = await api.call('purposes.list', {});
    expect(defaults.source).toBe('default');
    expect(defaults.purposes.every((p) => typeof p.requiresDoubleOptIn === 'boolean')).toBe(true);

    const a = await api.call('artifacts.create', {
      type: 'purposes',
      name: 'Purposes',
      content: {
        purposes: [
          {
            key: 'marketing_email',
            name: 'Marketing e-mail',
            description: 'News and offers by e-mail.',
            basis: 'consent',
            channels: ['email'],
            requiresDoubleOptIn: true,
          },
        ],
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'Go' });
    const published = await api.call('purposes.list', {});
    expect(published.source).toBe('published');
    expect(published.purposes[0].requiresDoubleOptIn).toBe(true);
  });
});
