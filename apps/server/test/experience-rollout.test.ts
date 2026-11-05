import { schema } from '@agentic-marketing/db';
import { decideAll, loadPublishedExperiences } from '@agentic-marketing/personalize';
import type { DecideContext } from '@agentic-marketing/personalize/targeting';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentEventsOnce } from '../src/agents/events';
import { type GuardrailReading, runExperienceRolloutsOnce } from '../src/agents/rollouts';
import { startTestServer, testPort, type User } from './harness';

// Progressive rollout (#427): a ramp starts small, widens on schedule, pauses when its guardrail
// fails and stops at once when a person (or an allowed agent) says so. The edge bundle carries the
// share, so the worker applies it without a server round trip.

let t: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  t = await startTestServer('test_experience_rollout', testPort(3600));
}, 90_000);

afterAll(async () => {
  await t?.close();
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
      content: { placement: 'hero', variants, rollout: { steps: [10, 100], stepHours: 1 } },
    });
    const out = await agentCall(token, 'artifacts.requestPublish', { artifactId: ramped.body.artifactId, note: 'with a ramp' });
    expect(out.body.status).toBe('published');
  });
});
