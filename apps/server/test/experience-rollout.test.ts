import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { schema } from '@agentic-marketing/db';
import { decideAll, loadPublishedExperiences, syncEdge } from '@agentic-marketing/personalize';
import type { DecideContext } from '@agentic-marketing/personalize/targeting';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentEventsOnce } from '../src/agents/events';
import { runHoldsOnce } from '../src/agents/holds';
import { type GuardrailReading, runExperienceRolloutsOnce } from '../src/agents/rollouts';
import { startTestServer, testPort, type User } from './harness';

// Progressive rollout (#427): a ramp starts small, widens on schedule, pauses when its guardrail
// fails and stops at once when a person (or an allowed agent) says so. The edge bundle carries the
// share, so the worker applies it without a server round trip.
//
// The edge sync runs once a day in this file: the kill-switch test proves the stop pushes the
// bundle itself (#477) rather than waiting for the scheduler.

let t: Awaited<ReturnType<typeof startTestServer>>;
let cf: Server;
let cfBase = '';
const ACCOUNT = 'a'.repeat(32);
const NS = 'b'.repeat(32);
/** A fake Cloudflare Workers KV: the same API surface the edge sync writes through. */
const kv = new Map<string, unknown>();

beforeAll(async () => {
  cf = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)(\/[^?]*)$/);
    if (!m) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }));
    const path = m[3];
    if (path === '/bulk' && req.method === 'PUT') for (const e of body) kv.set(e.key, JSON.parse(e.value));
    else if (path === '/bulk/delete' && req.method === 'POST') for (const k of body) kv.delete(k);
    else if (path === '/keys' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const names = [...kv.keys()].filter((k) => k.startsWith(prefix));
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, errors: [], result: names.map((name) => ({ name })) }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, errors: [] }));
  });
  await new Promise<void>((r) => cf.listen(0, '127.0.0.1', r));
  cfBase = `http://127.0.0.1:${(cf.address() as AddressInfo).port}`;
  t = await startTestServer('test_experience_rollout', testPort(3600), {}, { edgeTickMs: 86_400_000 });
}, 90_000);

afterAll(async () => {
  await t?.close();
  cf?.close();
});

let n = 0;
async function person(): Promise<{ user: User; ws: string; api: ReturnType<typeof t.api> }> {
  const user = await t.signUp(`owner-rollout-${++n}-${Date.now()}@example.com`);
  const ws = await t.workspaceWith([[user, 'owner']], 'none');
  return { user, ws, api: t.api(user, ws) };
}

const variants = [{ id: 'a', name: 'A', weight: 100, content: { html: '<h1>A</h1>' } }];
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function publishExperience(api: ReturnType<typeof t.api>, content: Record<string, unknown>) {
  const a = await api.call('artifacts.create', { type: 'experience', name: `Ramp ${++n}`, content });
  const out = await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'ramp' });
  expect(out.status).toBe('published');
  return a.artifactId;
}

const agentCall = async (token: string, name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const deps = () => ({
  db: t.srv.db,
  events: t.srv.events,
  hot: t.srv.hot,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.srv.publicUrl,
});

const snapshotOf = async (ws: string) => t.srv.db.withWorkspace(ws, (tx) => loadPublishedExperiences(tx));

const ctx: DecideContext = {
  personalized: true,
  snapshot: null,
  session: null,
  page: { url: 'https://shop.example.com/', path: '/', referrer: '' },
  utmSource: null,
  device: 'desktop',
};

describe('experience rollouts (#427)', () => {
  it('publishes at the first step and carries the share into the edge bundle', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, {
      placement: 'hero',
      variants,
      rollout: { steps: [5, 25, 100], stepHours: 1 },
    });
    const status = await api.call('experiences.rolloutStatus', { artifactId: id });
    expect(status).toMatchObject({ status: 'running', stepIndex: 0, share: 5, steps: [5, 25, 100], stepHours: 1 });
    expect(status.nextStepAt).not.toBeNull();
    const list = await snapshotOf(ws);
    expect(list.find((e) => e.id === id)?.share).toBe(5);
  });

  it('advances to the next step when the guardrail holds', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, {
      placement: 'hero',
      variants,
      rollout: { steps: [5, 25, 100], stepHours: 1, guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } },
    });
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx
        .update(schema.experienceRollouts)
        .set({ nextStepAt: new Date(Date.now() - 60_000) })
        .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, id))),
    );
    const holding: GuardrailReading = {
      at: new Date().toISOString(),
      measure: 'email.click_rate',
      value: 0.049,
      baseline: 0.05,
      dropPercent: 2,
      ok: true,
    };
    const out = await runExperienceRolloutsOnce({ ...deps(), measure: async () => holding });
    expect(out.advanced).toBe(1);
    const status = await api.call('experiences.rolloutStatus', { artifactId: id });
    expect(status).toMatchObject({ status: 'running', stepIndex: 1, share: 25 });
    expect((await snapshotOf(ws)).find((e) => e.id === id)?.share).toBe(25);
  });

  it('pauses on a guardrail failure and emits an agent event', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, {
      placement: 'hero',
      variants,
      rollout: { steps: [5, 25, 100], stepHours: 1, guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } },
    });
    const token = (await api.call('apiTokens.create', { name: 'Rollout agent', scopes: ['artifacts:read', 'artifacts:write'] }))
      .token as string;
    const agentId = (await agentCall(token, 'agents.get')).body.id as string;
    expect((await agentCall(token, 'agents.subscribe', { eventTypes: ['experience.rollout_paused'] })).status).toBe(200);

    await t.srv.db.withWorkspace(ws, (tx) =>
      tx
        .update(schema.experienceRollouts)
        .set({ nextStepAt: new Date(Date.now() - 60_000) })
        .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, id))),
    );
    const failing: GuardrailReading = {
      at: new Date().toISOString(),
      measure: 'email.click_rate',
      value: 0.01,
      baseline: 0.05,
      dropPercent: 80,
      ok: false,
    };
    const out = await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect(out.paused).toBe(1);

    const status = await api.call('experiences.rolloutStatus', { artifactId: id });
    expect(status).toMatchObject({ status: 'paused', stepIndex: 0, share: 5 });
    expect(status.reason).toContain('email.click_rate');
    expect(status.lastGuardrail).toMatchObject({ ok: false, dropPercent: 80 });

    await runAgentEventsOnce({ db: t.srv.db });
    const events = await agentCall(token, 'agents.events');
    const paused = events.body.events.find((e: { type: string }) => e.type === 'experience.rollout_paused');
    expect(paused).toBeTruthy();
    expect(paused.subject).toMatchObject({ artifactId: id, share: 5 });
    expect(paused.agentId).toBe(agentId);

    // A paused ramp stays where it is: another tick does not widen it.
    const again = await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect(again.advanced).toBe(0);
    expect((await api.call('experiences.rolloutStatus', { artifactId: id })).share).toBe(5);
  });

  it('the kill switch sets the share to 0 in the edge bundle at once', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, {
      placement: 'hero',
      variants,
      rollout: { steps: [5, 25, 100], stepHours: 1 },
    });
    expect((await snapshotOf(ws)).find((e) => e.id === id)?.share).toBe(5);

    const stopped = await api.call('experiences.stopRollout', { artifactId: id, reason: 'A conversion drop in the first hour' });
    expect(stopped).toMatchObject({ status: 'stopped', share: 0 });
    expect(stopped.stoppedAt).not.toBeNull();

    const list = await snapshotOf(ws);
    expect(list.find((e) => e.id === id)?.share).toBe(0);
    // Nobody is admitted while the ramp is stopped, whatever their sticky hash.
    expect(
      decideAll(
        list.filter((e) => e.id === id),
        ['hero'],
        ctx,
        'any-subject',
      ),
    ).toHaveLength(0);

    // Only a person can resume it.
    const resumed = await api.call('experiences.resumeRollout', { artifactId: id, reason: 'Fixed' });
    expect(resumed).toMatchObject({ status: 'running', share: 5 });
  });

  it('a mandate that requires a ramp sends an un-ramped agent experience to a person', async () => {
    const { api } = await person();
    await api.call('workspace.setAutonomy', { maxLevel: { 'experience.live': 3, 'content.publish': 3 } });
    const token = (
      await api.call('apiTokens.create', {
        name: 'Ramp mandate agent',
        scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
      })
    ).token as string;
    const agentId = (await agentCall(token, 'agents.get')).body.id as string;
    const mandate = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Require a ramp',
      content: {
        agent: agentId,
        purpose: 'Roll out experiences gradually',
        validUntil: inDays(30),
        levels: { 'experience.live': 3, 'content.publish': 3 },
        scope: { segments: [], purposes: [], topics: [], channels: [], artifactTypes: ['experience'], artifacts: [], brand: null },
        learning: { experienceRamp: true },
      } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');

    const plain = await agentCall(token, 'artifacts.create', {
      type: 'experience',
      name: 'No ramp',
      content: { placement: 'hero', variants },
    });
    const held = await agentCall(token, 'artifacts.requestPublish', { artifactId: plain.body.artifactId, note: 'no ramp' });
    expect(held.body.status).toBe('in_review');
    expect((held.body.heldBecause ?? []).join(' ')).toContain('ramp');

    const ramped = await agentCall(token, 'artifacts.create', {
      type: 'experience',
      name: 'Ramped',
      content: {
        placement: 'hero',
        variants,
        rollout: { steps: [10, 100], stepHours: 1, guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } },
      },
    });
    const out = await agentCall(token, 'artifacts.requestPublish', { artifactId: ramped.body.artifactId, note: 'with a ramp' });
    expect(out.body.status).toBe('published');
  });
});

const setDue = (ws: string, artifactId: string) =>
  t.srv.db.withWorkspace(ws, (tx) =>
    tx
      .update(schema.experienceRollouts)
      .set({ nextStepAt: new Date(Date.now() - 60_000) })
      .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, artifactId))),
  );

const rolloutRow = async (ws: string, artifactId: string) => {
  const [row] = await t.srv.db.withWorkspace(ws, (tx) =>
    tx
      .select()
      .from(schema.experienceRollouts)
      .where(and(eq(schema.experienceRollouts.workspaceId, ws), eq(schema.experienceRollouts.artifactId, artifactId))),
  );
  return row;
};

const holding: GuardrailReading = {
  at: new Date().toISOString(),
  measure: 'email.click_rate',
  value: 0.049,
  baseline: 0.05,
  dropPercent: 2,
  ok: true,
};
const failing: GuardrailReading = {
  at: new Date().toISOString(),
  measure: 'email.click_rate',
  value: 0.01,
  baseline: 0.05,
  dropPercent: 80,
  ok: false,
};

async function agentFor(api: ReturnType<typeof t.api>, name: string) {
  const token = (await api.call('apiTokens.create', { name, scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] }))
    .token as string;
  const agentId = (await agentCall(token, 'agents.get')).body.id as string;
  return { token, agentId };
}

/** A mandate that lets the agent publish one experience at level 3 (act within limits). */
async function grantExperience(api: ReturnType<typeof t.api>, agentId: string, artifactId: string) {
  await api.call('workspace.setAutonomy', { maxLevel: { 'experience.live': 3 } });
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: `Experience ramp mandate ${++n}`,
    content: {
      agent: agentId,
      purpose: 'Roll out experiences gradually',
      validUntil: inDays(30),
      levels: { 'experience.live': 3 },
      scope: { segments: [], purposes: [], topics: [], channels: [], artifactTypes: ['experience'], artifacts: [artifactId], brand: null },
      learning: {},
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
}

const ramp = (over: Record<string, unknown> = {}) => ({
  placement: 'hero',
  variants,
  rollout: { steps: [5, 25, 100], stepHours: 1, ...over },
});

describe('a person’s stop is sticky (#454)', () => {
  it('records who stopped it and does not let an agent republish restart it', async () => {
    const { ws, api } = await person();
    const content = ramp();
    const id = await publishExperience(api, content);
    const { token } = await agentFor(api, 'Ramp owner');
    await grantExperience(api, (await agentCall(token, 'agents.get')).body.id as string, id);

    expect((await api.call('experiences.stopRollout', { artifactId: id, reason: 'Conversion collapse' })).status).toBe('stopped');
    const stopped = await rolloutRow(ws, id);
    expect(stopped).toMatchObject({ stoppedByAgent: false, share: 0 });
    expect(stopped.stoppedBy).toBeTruthy();

    // An unrelated metadata edit republished by the agent must not start the ramp again.
    const draft = await agentCall(token, 'artifacts.updateDraft', { artifactId: id, content: { ...content, priority: 5 } });
    expect(draft.status).toBe(200);
    const published = await agentCall(token, 'artifacts.requestPublish', { artifactId: id, note: 'priority only' });
    expect(published.body.status).toBe('published');
    expect(await api.call('experiences.rolloutStatus', { artifactId: id })).toMatchObject({ status: 'stopped', share: 0 });

    // Neither can it clear the stop by publishing a version without a ramp.
    const plain = await agentCall(token, 'artifacts.updateDraft', {
      artifactId: id,
      content: { placement: 'hero', variants, priority: 6 },
    });
    expect(plain.status).toBe(200);
    expect((await agentCall(token, 'artifacts.requestPublish', { artifactId: id, note: 'no ramp' })).body.status).toBe('published');
    expect(await api.call('experiences.rolloutStatus', { artifactId: id })).toMatchObject({ status: 'stopped', share: 0 });
    expect((await snapshotOf(ws)).find((e) => e.id === id)?.share).toBe(0);
  });

  it('a held agent publish after a person’s stop keeps the ramp stopped (#454)', async () => {
    const { ws, api } = await person();
    const content = ramp();
    const id = await publishExperience(api, content);
    const { token, agentId } = await agentFor(api, 'Held ramp agent');
    await api.call('workspace.setAutonomy', { maxLevel: { 'experience.live': 3 } });
    // Level 2 acts with veto: the agent's publish waits in a held approval instead of running.
    const mandate = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Held ramp mandate',
      content: {
        agent: agentId,
        purpose: 'Roll out experiences gradually',
        validUntil: inDays(30),
        levels: { 'experience.live': 2 },
        scope: { segments: [], purposes: [], topics: [], channels: [], artifactTypes: ['experience'], artifacts: [id], brand: null },
        learning: {},
      } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');

    expect((await agentCall(token, 'artifacts.updateDraft', { artifactId: id, content: { ...content, priority: 12 } })).status).toBe(200);
    const held = await agentCall(token, 'artifacts.requestPublish', { artifactId: id, note: 'held republish' });
    expect(held.body.status).toBe('on_hold');

    // A person stops the live ramp while the veto window is open.
    expect((await api.call('experiences.stopRollout', { artifactId: id, reason: 'Conversion collapse' })).status).toBe('stopped');

    // The veto window ends and the scheduler publishes the held version on the agent's behalf.
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`UPDATE approval_requests SET hold_until = now() - interval '1 minute'
        WHERE workspace_id = ${ws} AND artifact_id = ${id}`),
    );
    await runHoldsOnce({ db: t.srv.db, services: t.srv.services });
    expect(await api.call('experiences.rolloutStatus', { artifactId: id })).toMatchObject({ status: 'stopped', share: 0 });
    expect((await snapshotOf(ws)).find((e) => e.id === id)?.share).toBe(0);
  });

  it('a person’s republish starts a stopped ramp again', async () => {
    const { api } = await person();
    const content = ramp();
    const id = await publishExperience(api, content);
    expect((await api.call('experiences.stopRollout', { artifactId: id, reason: 'Emergency' })).status).toBe('stopped');

    // A person republishing is one of the two explicit restarts (the other is resumeRollout).
    await api.call('artifacts.updateDraft', { artifactId: id, content: { ...content, priority: 7 } });
    expect((await api.call('artifacts.requestPublish', { artifactId: id, note: 'person restart' })).status).toBe('published');
    expect(await api.call('experiences.rolloutStatus', { artifactId: id })).toMatchObject({ status: 'running', share: 5 });

    // resumeRollout also starts it again.
    expect((await api.call('experiences.stopRollout', { artifactId: id, reason: 'Second stop' })).status).toBe('stopped');
    expect(await api.call('experiences.resumeRollout', { artifactId: id, reason: 'Fixed' })).toMatchObject({ status: 'running', share: 5 });
  });

  it('a stop made by an agent is recorded as such and a later agent republish may restart it', async () => {
    const { ws, api } = await person();
    const content = ramp();
    const id = await publishExperience(api, content);
    const { token, agentId } = await agentFor(api, 'Self-stopping agent');
    await grantExperience(api, agentId, id);

    const stopped = await agentCall(token, 'experiences.stopRollout', { artifactId: id, reason: 'Its own guardrail concern' });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ status: 'stopped', share: 0 });
    expect((await rolloutRow(ws, id)).stoppedByAgent).toBe(true);

    await agentCall(token, 'artifacts.updateDraft', { artifactId: id, content: { ...content, priority: 9 } });
    expect((await agentCall(token, 'artifacts.requestPublish', { artifactId: id, note: 'new attempt' })).body.status).toBe('published');
    expect(await api.call('experiences.rolloutStatus', { artifactId: id })).toMatchObject({ status: 'running', share: 5 });
  });
});

describe('rollout errors are sanitised (0.14.16 review round 2)', () => {
  it('stores a fixed reason when an unexpected step failure carries secret text', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, ramp());
    await setDue(ws, id);
    const base = deps();
    await runExperienceRolloutsOnce({
      ...base,
      hot: {
        ...base.hot,
        bump: async () => {
          throw new Error('cache failure: password=probe-secret');
        },
      } as typeof base.hot,
    });
    const status = await api.call('experiences.rolloutStatus', { artifactId: id });
    expect(status.lastError ?? '').not.toContain('probe-secret');
  });
});

describe('a sweep isolates each ramp (#474)', () => {
  it('one broken guardrail read freezes only its own ramp and records the error', async () => {
    const { ws, api } = await person();
    const a = await publishExperience(api, ramp());
    const b = await publishExperience(api, ramp({ guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } }));
    await setDue(ws, a);
    await setDue(ws, b);

    const out = await runExperienceRolloutsOnce({
      ...deps(),
      measure: async () => {
        throw new Error('ClickHouse timed out: password=probe-secret');
      },
    });
    expect(out.failed).toBe(1);
    // The un-guarded ramp widened; the broken one waited at its current step.
    expect((await api.call('experiences.rolloutStatus', { artifactId: a })).share).toBe(25);
    expect(await api.call('experiences.rolloutStatus', { artifactId: b })).toMatchObject({ status: 'running', share: 5 });
    // A fixed reason, never the raw driver text, which can carry credentials (0.14.16 review round 2).
    const lastError = (await api.call('experiences.rolloutStatus', { artifactId: b })).lastError;
    expect(lastError).toContain('guardrail');
    expect(lastError).not.toContain('probe-secret');
    expect((await api.call('experiences.rolloutStatus', { artifactId: a })).lastError).toBeNull();

    // The next round retries it alone and clears the error.
    const next = await runExperienceRolloutsOnce({ ...deps(), measure: async () => holding });
    expect(next.advanced).toBeGreaterThanOrEqual(1);
    expect((await api.call('experiences.rolloutStatus', { artifactId: b })).share).toBe(25);
    expect((await api.call('experiences.rolloutStatus', { artifactId: b })).lastError).toBeNull();
  });

  it('a pause committed for one ramp survives another ramp’s failure', async () => {
    const { ws, api } = await person();
    const pausing = await publishExperience(api, ramp({ guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } }));
    const broken = await publishExperience(api, ramp({ guardrail: { measure: 'email.open_rate', maxDropPercent: 20 } }));
    await setDue(ws, pausing);
    await setDue(ws, broken);

    const out = await runExperienceRolloutsOnce({
      ...deps(),
      measure: async (_tx, _ws, guardrail) => {
        if (guardrail.measure === 'email.open_rate') throw new Error('metrics store unavailable');
        return failing;
      },
    });
    expect(out.failed).toBe(1);
    expect(out.paused).toBeGreaterThanOrEqual(1);
    expect(await api.call('experiences.rolloutStatus', { artifactId: pausing })).toMatchObject({ status: 'paused', share: 5 });
    expect(await api.call('experiences.rolloutStatus', { artifactId: broken })).toMatchObject({ status: 'running', share: 5 });
    const [pause] = await t.srv.db.withWorkspace(ws, (tx) =>
      tx
        .select()
        .from(schema.experienceRolloutPauses)
        .where(and(eq(schema.experienceRolloutPauses.workspaceId, ws), eq(schema.experienceRolloutPauses.artifactId, pausing))),
    );
    expect(pause).toMatchObject({ share: 5, version: 1 });
  });
});

describe('pause delivery is durable and idempotent (#473, #476)', () => {
  it('sends the owner e-mail after the pause commits, once per pause', async () => {
    const { ws, api } = await person();
    await api.call('emailProviders.create', {
      name: 'Outbox',
      adapter: 'log',
      fromEmail: 'ops@example.com',
      useFor: ['transactional'],
    });
    const id = await publishExperience(api, ramp({ guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } }));
    await setDue(ws, id);

    const out = await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect(out.paused).toBeGreaterThanOrEqual(1);
    const keys = async () =>
      (
        await t.srv.db.admin.query<{ idempotency_key: string; status: string }>(
          `SELECT idempotency_key, status FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE $2`,
          [ws, `experience-rollout:${id}:%`],
        )
      ).rows;
    const first = await keys();
    expect(first).toHaveLength(1);
    expect(first[0].idempotency_key).toContain(String((await rolloutRow(ws, id)).pausedAt?.toISOString()));
    const [pause] = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.select().from(schema.experienceRolloutPauses).where(eq(schema.experienceRolloutPauses.workspaceId, ws)),
    );
    expect(pause.notifiedAt).not.toBeNull();
    expect(pause.notifyError).toBeNull();

    // Another round does not send it again.
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect(await keys()).toHaveLength(1);

    // A crash between the pause and the e-mail leaves the outbox row; the retry reuses the message.
    await t.srv.db.admin.query(`UPDATE experience_rollout_pauses SET notified_at = NULL WHERE workspace_id = $1 AND artifact_id = $2`, [
      ws,
      id,
    ]);
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect(await keys()).toHaveLength(1);
    const [retried] = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.select().from(schema.experienceRolloutPauses).where(eq(schema.experienceRolloutPauses.workspaceId, ws)),
    );
    expect(retried.notifiedAt).not.toBeNull();
  });

  it('delivers experience.rollout_paused even when a stop follows before the event sweep (#476)', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, ramp({ guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } }));
    const { token } = await agentFor(api, 'Pause watcher');
    expect((await agentCall(token, 'agents.subscribe', { eventTypes: ['experience.rollout_paused'] })).status).toBe(200);
    await setDue(ws, id);

    expect((await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing })).paused).toBeGreaterThanOrEqual(1);
    // The person hits the kill switch inside the sweep window, which clears paused_at on the ramp.
    expect((await api.call('experiences.stopRollout', { artifactId: id, reason: 'Stopping it now' })).status).toBe('stopped');
    expect((await rolloutRow(ws, id)).pausedAt).toBeNull();

    await runAgentEventsOnce({ db: t.srv.db });
    const events = await agentCall(token, 'agents.events');
    const paused = events.body.events.find((e: { type: string }) => e.type === 'experience.rollout_paused');
    expect(paused).toBeTruthy();
    expect(paused.subject).toMatchObject({ artifactId: id, share: 5 });
  });
});

describe('pause notification state survives failures (#473)', () => {
  it('keeps a failed owner e-mail owed, backs off, then sends it once', async () => {
    const { ws, api } = await person();
    const id = await publishExperience(api, ramp({ guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } }));
    await setDue(ws, id);
    const pauseOf = async () =>
      (
        await t.srv.db.withWorkspace(ws, (tx) =>
          tx.select().from(schema.experienceRolloutPauses).where(eq(schema.experienceRolloutPauses.workspaceId, ws)),
        )
      )[0];
    const messageKeys = async () =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE $2`,
          [ws, `experience-rollout:${id}:%`],
        )
      ).rows[0]?.n ?? 0;

    // No transactional provider: the send fails, but the pause must not be marked as notified.
    expect((await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing })).paused).toBeGreaterThanOrEqual(1);
    const failed = await pauseOf();
    expect(failed).toMatchObject({ notifiedAt: null, notifyingAt: null, notifyAttempts: 1 });
    expect(failed?.notifyError).toContain('provider');
    expect(failed?.notifyAfter?.getTime() ?? 0).toBeGreaterThan(Date.now());
    expect(await messageKeys()).toBe(0);

    // Inside the backoff, another round does not retry.
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect((await pauseOf())?.notifyAttempts).toBe(1);

    // Once a provider exists and the backoff has passed, the next round delivers and marks it.
    await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'ops@example.com', useFor: ['transactional'] });
    await t.srv.db.admin.query(
      `UPDATE experience_rollout_pauses SET notify_after = now() - interval '1 second' WHERE workspace_id = $1 AND artifact_id = $2`,
      [ws, id],
    );
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    const sent = await pauseOf();
    expect(sent).toMatchObject({ notifyingAt: null, notifyAttempts: 2, notifyError: null });
    expect(sent?.notifiedAt).not.toBeNull();
    expect(sent?.notifyAfter).toBeNull();
    expect(await messageKeys()).toBe(1);
  });

  it('does not resend when a crash left a claim, and retries that claim after the lease', async () => {
    const { ws, api } = await person();
    await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'ops@example.com', useFor: ['transactional'] });
    const id = await publishExperience(api, ramp({ guardrail: { measure: 'email.click_rate', maxDropPercent: 20 } }));
    await setDue(ws, id);
    const messageKeys = async () =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE $2`,
          [ws, `experience-rollout:${id}:%`],
        )
      ).rows[0]?.n ?? 0;
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    expect(await messageKeys()).toBe(1);

    // The send committed with the provider but the mark did not: simulated by a fresh claim.
    await t.srv.db.admin.query(
      `UPDATE experience_rollout_pauses SET notified_at = NULL, notifying_at = now(), notify_attempts = 2
        WHERE workspace_id = $1 AND artifact_id = $2`,
      [ws, id],
    );
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    const [claimed] = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.select().from(schema.experienceRolloutPauses).where(eq(schema.experienceRolloutPauses.workspaceId, ws)),
    );
    expect(claimed).toMatchObject({ notifiedAt: null, notifyAttempts: 2 });
    expect(await messageKeys()).toBe(1);

    // The lease expires: the retry sees the earlier message as sent and does not duplicate it.
    await t.srv.db.admin.query(
      `UPDATE experience_rollout_pauses SET notifying_at = now() - interval '11 minutes'
        WHERE workspace_id = $1 AND artifact_id = $2`,
      [ws, id],
    );
    await runExperienceRolloutsOnce({ ...deps(), measure: async () => failing });
    const [retried] = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.select().from(schema.experienceRolloutPauses).where(eq(schema.experienceRolloutPauses.workspaceId, ws)),
    );
    expect(retried).toMatchObject({ notifyAttempts: 3, notifyError: null });
    expect(retried?.notifiedAt).not.toBeNull();
    expect(await messageKeys()).toBe(1);
  });
});

describe('the kill switch reaches KV before it returns (#477)', () => {
  it('pushes the stopped bundle to KV without waiting for the sync tick', async () => {
    const { ws, api } = await person();
    await api.call('edge.configure', {
      accountId: ACCOUNT,
      namespaceId: NS,
      apiToken: 'cf-token-0123456789abcdef',
      apiBase: cfBase,
      enabled: true,
    });
    const id = await publishExperience(api, ramp());
    // The background sync runs once a day in this file, so push the live bundle by hand.
    await syncEdge({ db: t.srv.db, hot: t.srv.hot, kp: t.srv.keyProvider, egress: t.srv.egress }, ws);
    const bundle = () => kv.get(`am:exp:${ws}`) as { experiences: { id: string; share: number | null }[] };
    expect(bundle().experiences.find((e) => e.id === id)?.share).toBe(5);

    const stopped = await api.call('experiences.stopRollout', { artifactId: id, reason: 'Conversion collapse' });
    // No wait, no tick: the stop pushed the new share before it returned, and said so.
    expect(stopped).toMatchObject({ edgePushed: true, edgePushReason: null });
    expect(bundle().experiences.find((e) => e.id === id)?.share).toBe(0);
  });

  it('waits for a running edge sync instead of skipping the stop push', async () => {
    const { ws, api } = await person();
    await api.call('edge.configure', {
      accountId: ACCOUNT,
      namespaceId: NS,
      apiToken: 'cf-token-0123456789abcdef',
      apiBase: cfBase,
      enabled: true,
    });
    const id = await publishExperience(api, ramp());
    await syncEdge({ db: t.srv.db, hot: t.srv.hot, kp: t.srv.keyProvider, egress: t.srv.egress }, ws);
    const bundle = () => kv.get(`am:exp:${ws}`) as { experiences: { id: string; share: number | null }[] };
    expect(bundle().experiences.find((e) => e.id === id)?.share).toBe(5);

    // A background sync holds the same advisory key the stop needs.
    const client = await t.srv.db.admin.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`edge-sync:${ws}`]);
      const stopping = api.call('experiences.stopRollout', { artifactId: id, reason: 'Waiting for the lock' });
      await new Promise((resolve) => setTimeout(resolve, 250));
      // It has not skipped: the old bundle is still there while the stop waits.
      expect(bundle().experiences.find((e) => e.id === id)?.share).toBe(5);
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`edge-sync:${ws}`]);
      const stopped = await stopping;
      expect(stopped.edgePushed).toBe(true);
      expect(bundle().experiences.find((e) => e.id === id)?.share).toBe(0);
    } finally {
      client.release();
    }
  });

  it('reports a push it could not make instead of swallowing the failure', async () => {
    const { api } = await person();
    const id = await publishExperience(api, ramp());
    const stopped = await api.call('experiences.stopRollout', { artifactId: id, reason: 'No edge configured' });
    expect(stopped).toMatchObject({ status: 'stopped', share: 0, edgePushed: false });
    expect(stopped.edgePushReason).toContain('not configured');
  });
});
