import { type FakeSystemOneRequest, fakeSystemOne } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 21 (#194, epic #192): decision models. A third AI provider kind answers typed questions
// with probabilities instead of text; ai.score meters the call and can store a named score,
// segments read it, a journey decision node routes by a threshold and falls back, and
// ai.calibration compares predictions with a later event.

let t: Awaited<ReturnType<typeof startTestServer>>;
let sys: Awaited<ReturnType<typeof fakeSystemOne>>;
let owner: User;
let key = '';
let providerId = '';
let journeyId = '';

const noul = (key: string, instructions: string) => ({ key, type: 'noul' as const, instructions });
const NOUL = noul('conversion_propensity', 'Is this person likely to convert in the next 14 days?');

/** The fake answers by the state it was given: `p` sets a noul probability, `fail` errors. */
function answer(r: FakeSystemOneRequest) {
  const state = (r.state ?? {}) as { p?: number; fail?: boolean; traits?: { fail?: boolean } };
  if (state.fail || state.traits?.fail) return { status: 500, error: 'upstream model exploded' };
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [id, q] of Object.entries(r.questions)) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: state.p ?? 0.82 };
    else if (q.type === 'choice')
      answers[id] = { type: 'choice', choice: 'email', confidence: 0.7, probabilities: { email: 0.7, sms: 0.2, push: 0.1 } };
    else answers[id] = { type: 'score', score: 1.5, confidence: 0.5, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } };
  }
  return { answers, inputTokens: 210, outputTokens: 14 };
}

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });
const aiConsent = (userId: string, yes = true) => ({
  type: 'track',
  event: 'Segment Consent Preference Updated',
  userId,
  context: { consent: { categoryPreferences: { ai_processing: yes } } },
});

async function publish(type: string, name: string, content: unknown) {
  const api = t.api(owner);
  const a = await api.call('artifacts.create', { type: type as 'note', name, content: content as Record<string, unknown> });
  await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
  return a.artifactId;
}

async function profileOf(userId: string) {
  const api = t.api(owner);
  return eventually(
    async () => (await api.call('profiles.find', { type: 'user_id', value: userId })).profileId,
    (id) => !!id,
  );
}

beforeAll(async () => {
  sys = await fakeSystemOne(answer);
  t = await startTestServer('test_decision_models', testPort(3465));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;
  providerId = (
    await api.call('aiProviders.create', {
      name: 'TypeSafe JEV',
      kind: 'decision',
      baseUrl: sys.baseUrl,
      models: { default: 'typesafe/jev' },
      apiKey: 'sk-test-typesafe',
      useFor: ['decisions'],
      monthlyTokenBudget: null,
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await t?.close();
  await sys?.close();
});

describe('ai.score', () => {
  it('returns typed answers and logs one ai_calls row of kind score with tokens', async () => {
    const api = t.api(owner);
    const r = await api.call('ai.score', {
      questions: [
        NOUL,
        { key: 'channel', type: 'choice', instructions: 'Which channel?', criteria: { email: 'E-mail', sms: 'SMS', push: 'Push' } },
        { key: 'intent', type: 'score', instructions: 'How strong?', criteria: ['Low', 'Medium', 'High'] },
      ],
      state: { plan: 'pro', pageViews: 3 },
    });
    expect(r).toMatchObject({ model: 'typesafe/jev', modelVersion: 'jev-test-1.0.0', inputTokens: 210, outputTokens: 14 });
    expect(r.answers).toHaveLength(3);
    expect(r.answers[0]).toMatchObject({ key: 'conversion_propensity', type: 'noul', probability: 0.82 });
    expect(r.answers[1]).toMatchObject({ key: 'channel', label: 'email', probability: 0.7 });
    expect(r.answers[2]).toMatchObject({ key: 'intent', value: 1.5, probability: 0.75 });
    expect(r.callId).toMatch(/^aic_/);
    expect(sys.requests.at(-1)).toMatchObject({ model: 'typesafe/jev', apiKey: 'sk-test-typesafe', state: { plan: 'pro', pageViews: 3 } });

    const calls = (await api.call('ai.calls', { kind: 'score' })).calls;
    const call = calls.find((c) => c.id === r.callId)!;
    expect(call).toMatchObject({ status: 'done', model: 'jev-test-1.0.0', profileId: null, error: null });
    expect(call.inputTokens).toBeGreaterThan(0);
    expect(call.input).toMatchObject({ stateTokens: expect.any(Number) });
    // The state itself is never logged; only its hash.
    expect(JSON.stringify(call.input)).not.toContain('pageViews');
    expect((await api.call('ai.usage', { days: 1 })).days.some((d) => d.kind === 'score' && d.calls >= 1)).toBe(true);
  });

  it('refuses a state with an e-mail address when the provider has no no-retention agreement', async () => {
    const api = t.api(owner);
    const before = sys.requests.length;
    const err = await rejects(api.call('ai.score', { questions: [NOUL], state: { note: 'write to ada@example.com' } }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('contains email data');
    expect(err.message).toContain('no zero-data-retention agreement');
    expect(sys.requests.length).toBe(before);
    // Failed calls are still visible, so a refused state is auditable.
    const failed = (await api.call('ai.calls', { kind: 'score' })).calls.filter((c) => c.status === 'failed');
    expect(failed.some((c) => c.error?.includes('no zero-data-retention'))).toBe(true);
  });

  it('allows personal data only after a person marks the provider allowPersonalData', async () => {
    const api = t.api(owner);
    await api.call('aiProviders.update', { id: providerId, allowPersonalData: true });
    try {
      const r = await api.call('ai.score', { questions: [NOUL], state: { email: 'ada@example.com' } });
      expect(r.answers[0].probability).toBe(0.82);
      expect((await api.call('aiProviders.list', {})).providers[0].allowPersonalData).toBe(true);
    } finally {
      await api.call('aiProviders.update', { id: providerId, allowPersonalData: false });
    }
  });

  it('enforces the 100-question limit and the monthly budget', async () => {
    const api = t.api(owner);
    const tooMany = Array.from({ length: 101 }, (_, i) => noul(`q_${i}`, 'Will this happen?'));
    expect((await rejects(api.call('ai.score', { questions: tooMany, state: { x: 1 } }))).code).toBe('invalid_input');

    await api.call('aiProviders.update', { id: providerId, monthlyTokenBudget: 1 });
    try {
      const err = await rejects(api.call('ai.score', { questions: [NOUL], state: { plan: 'pro' } }));
      expect(err.code).toBe('conflict');
      expect(err.message).toContain('budget');
    } finally {
      await api.call('aiProviders.update', { id: providerId, monthlyTokenBudget: null });
    }
  });

  it('stores a named score that a person can read and a segment can use', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'scored', traits: { plan: 'pro', lifetime_value: 2400 } }, aiConsent('scored')]);
    const profileId = (await profileOf('scored'))!;
    const r = await api.call('ai.score', {
      questions: [NOUL],
      profileId,
      store: { key: 'conversion_propensity', ttlHours: 24 },
    });
    expect(r.stored).toMatchObject({ profileId, key: 'conversion_propensity', value: 0.82 });
    // The state was built from the person: non-personal traits and event counts, not identifiers.
    const request = sys.requests.at(-1)!;
    expect(request.state).toMatchObject({ traits: { plan: 'pro', lifetime_value: 2400 } });
    expect(JSON.stringify(request.state)).not.toContain('scored');

    const scores = await api.call('profiles.scores', { profileId });
    expect(scores.scores).toHaveLength(1);
    expect(scores.scores[0]).toMatchObject({
      key: 'conversion_propensity',
      value: 0.82,
      model: 'typesafe/jev',
      modelVersion: 'jev-test-1.0.0',
    });

    const matching = await api.call('segments.preview', {
      condition: { score: { key: 'conversion_propensity', gte: 0.5 } },
    });
    expect(matching.sample).toContain(profileId);
    const tooHigh = await api.call('segments.preview', {
      condition: { score: { key: 'conversion_propensity', gte: 0.95 } },
    });
    expect(tooHigh.sample).not.toContain(profileId);
    const expired = await api.call('segments.preview', {
      condition: { score: { key: 'no_such_score', gte: 0 } },
    });
    expect(expired.count).toBe(0);
  });
});

describe('a decision node in a journey', () => {
  beforeAll(async () => {
    journeyId = await publish('journey', 'Decide who gets the offer', {
      purpose: 'marketing_email',
      nodes: [
        { id: 'start', kind: 'trigger', label: 'Scored', config: { event: 'Decision Ready', reentry: 'once' } },
        {
          id: 'decide',
          kind: 'decision',
          label: 'Likely to convert?',
          config: { question: NOUL, threshold: 0.5, timeout: 'PT5M' },
          next: [{ to: 'high' }, { to: 'low' }],
        },
        { id: 'high', kind: 'updateProfile', label: 'High', config: { trait: 'decision_path', value: 'high' }, next: [{ to: 'end' }] },
        { id: 'low', kind: 'updateProfile', label: 'Low', config: { trait: 'decision_path', value: 'low' }, next: [{ to: 'end' }] },
        { id: 'end', kind: 'exit', label: 'Done', config: {} },
      ],
    });
  }, 60_000);

  it('validates the threshold, the question and the two edges on publish', async () => {
    const api = t.api(owner);
    const content = (threshold: number, edges: number) => ({
      purpose: 'marketing_email',
      nodes: [
        { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Anything', reentry: 'once' } },
        {
          id: 'decide',
          kind: 'decision',
          label: 'Broken',
          config: { question: noul('x', 'Is it?'), threshold },
          next: Array.from({ length: edges }, () => ({ to: 'end' })),
        },
        { id: 'end', kind: 'exit', label: 'End', config: {} },
      ],
    });
    const oneEdge = await rejects(api.call('artifacts.create', { type: 'journey', name: 'One edge', content: content(0.5, 1) }));
    expect(oneEdge.message).toContain('two edges');
    const draft = await api.call('artifacts.create', { type: 'journey', name: 'Bad threshold', content: content(2, 2) });
    const err = await rejects(api.call('artifacts.requestPublish', { artifactId: draft.artifactId, note: 'x' }));
    expect(err.message).toContain('threshold');
  });

  it('simulates the probability and the fallback edge', async () => {
    const api = t.api(owner);
    const high = await api.call('journeys.simulate', { artifactId: journeyId, scores: { decide: 0.9 } });
    expect(high.steps.map((s) => `${s.node}: ${s.detail}`)).toEqual([
      'start: ',
      'decide: probability 0.900 ≥ 0.5',
      'high: would set decision_path = "high"',
      'end: ',
    ]);
    const fallback = await api.call('journeys.simulate', { artifactId: journeyId });
    expect(fallback.steps.map((s) => `${s.node}: ${s.detail}`)).toContain('decide: fallback (not called in a simulation)');
    expect(fallback.steps.map((s) => s.node)).toContain('low');
  });

  it('routes by the threshold end to end and falls back on a provider error', async () => {
    const api = t.api(owner);
    await send([
      { type: 'identify', userId: 'router_high', traits: { plan: 'pro' } },
      aiConsent('router_high'),
      { type: 'track', event: 'Decision Ready', userId: 'router_high' },
      { type: 'identify', userId: 'router_fail', traits: { plan: 'pro', fail: true } },
      aiConsent('router_fail'),
      { type: 'track', event: 'Decision Ready', userId: 'router_fail' },
    ]);
    const high = (await profileOf('router_high'))!;
    const low = (await profileOf('router_fail'))!;
    const highProfile = await eventually(
      () => api.call('profiles.get', { profileId: high }),
      (p) => p.traits.decision_path === 'high',
      20_000,
    );
    expect(highProfile.traits.decision_path).toBe('high');
    const lowProfile = await eventually(
      () => api.call('profiles.get', { profileId: low }),
      (p) => p.traits.decision_path === 'low',
      20_000,
    );
    expect(lowProfile.traits.decision_path).toBe('low');

    const { calls } = await api.call('ai.calls', { journeyId });
    const done = calls.filter((c) => c.kind === 'score' && c.node === 'decide' && c.status === 'done');
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done[0].output).toMatchObject({ answers: [{ key: 'conversion_propensity', probability: 0.82 }] });
    const failed = calls.filter((c) => c.kind === 'score' && c.status === 'fallback');
    expect(failed.some((c) => c.error?.includes('upstream model exploded'))).toBe(true);
    const stored = await api.call('profiles.scores', { profileId: high });
    expect(stored.scores.find((s) => s.key === 'conversion_propensity')?.value).toBe(0.82);
  }, 30_000);
});

describe('ai.calibration', () => {
  it('returns a reliability table and the Brier score for seeded predictions and outcomes', async () => {
    const api = t.api(owner);
    const people = [
      { id: 'cal_1', p: 0.9, convert: true },
      { id: 'cal_2', p: 0.8, convert: false },
      { id: 'cal_3', p: 0.3, convert: true },
      { id: 'cal_4', p: 0.2, convert: false },
    ];
    // Predictions first, outcomes later: that is the order calibration measures.
    await send(people.flatMap((p) => [{ type: 'identify', userId: p.id }, aiConsent(p.id)]));
    const ids: Record<string, string> = {};
    for (const p of people) {
      const profileId = (await profileOf(p.id))!;
      ids[p.id] = profileId;
      await api.call('ai.score', {
        questions: [NOUL],
        profileId,
        state: { p: p.p },
        store: { key: 'calibration_test', ttlHours: 24 },
      });
    }
    await send(
      people.filter((p) => p.convert).map((p) => ({ type: 'track', event: 'Order Completed', userId: p.id, properties: { order: p.id } })),
    );
    // Wait until the two outcomes are in the event store.
    await eventually(
      () => api.call('profiles.events', { profileId: ids.cal_1 }),
      (r) => r.events.some((e) => e.name === 'Order Completed'),
    );
    const r = await eventually(
      () => api.call('ai.calibration', { scoreKey: 'calibration_test', event: 'Order Completed', withinDays: 14 }),
      (x) => x.positives === 2,
    );
    expect(r).toMatchObject({ predictions: 4, positives: 2, baseRate: 0.5, withinDays: 14 });
    // (0.1² + 0.8² + 0.7² + 0.2²) / 4 = 0.295
    expect(r.brierScore).toBeCloseTo(0.295, 6);
    expect(r.reliability).toHaveLength(10);
    const bin = (predicted: number) => r.reliability.find((b) => b.n > 0 && Math.abs((b.predicted ?? 0) - predicted) < 1e-9)!;
    expect(bin(0.2)).toMatchObject({ n: 1, predicted: 0.2, observed: 0 });
    expect(bin(0.3)).toMatchObject({ n: 1, predicted: 0.3, observed: 1 });
    expect(bin(0.8)).toMatchObject({ n: 1, predicted: 0.8, observed: 0 });
    expect(bin(0.9)).toMatchObject({ n: 1, predicted: 0.9, observed: 1 });
    expect(r.reliability.filter((b) => b.n === 0).every((b) => b.predicted === null)).toBe(true);
  }, 30_000);
});
