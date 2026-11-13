import { describe, expect, it } from 'vitest';
import { autonomySettings, decide, type MandateView, type PolicyInput } from '../src/policy';

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  command: 'artifacts.requestPublish',
  actionClass: 'content.publish',
  impact: {},
  settings: autonomySettings({}),
  counters: { changes: 0, messages: 0 },
  approvable: true,
  ...over,
});

describe('autonomy settings', () => {
  it('default to a person in charge: level 1, threshold 1,000, switch on', () => {
    const s = autonomySettings({});
    expect(s).toMatchObject({ switch: 'on', audienceThreshold: 1000, allowLoops: false, maxLevel: {} });
    expect(s.limits).toEqual({ changesPerDay: 500, messagesPerDay: 1000 });
  });

  it('fall back to the defaults when the stored value is unreadable', () => {
    expect(autonomySettings({ switch: 'sometimes' }).switch).toBe('on');
    expect(autonomySettings(null).audienceThreshold).toBe(1000);
  });
});

describe('the policy engine', () => {
  it('allows reads and drafts', () => {
    expect(decide(base({ actionClass: 'read' })).decision).toBe('allow');
    expect(decide(base({ actionClass: 'draft' })).decision).toBe('allow');
  });

  it('leaves an agent without a mandate to the approval policy when nothing is exceeded', () => {
    expect(decide(base()).decision).toBe('allow');
    expect(decide(base({ actionClass: 'send.broadcast', impact: { people: 1000 } })).decision).toBe('allow');
  });

  it('sends an action reaching more people than the threshold to a person', () => {
    const out = decide(base({ actionClass: 'send.broadcast', impact: { people: 1001 } }));
    expect(out.decision).toBe('ask');
    expect(out.reasons[0]).toContain('1,001 people, above the workspace’s threshold of 1,000');
  });

  it('applies the threshold only to classes that reach people', () => {
    expect(decide(base({ actionClass: 'audience.publish', impact: { people: 50_000 } })).decision).toBe('allow');
    expect(decide(base({ actionClass: 'journey.live', impact: { people: 50_000 } })).decision).toBe('ask');
  });

  it('refuses what cannot wait for an approval, with the reason and a way out', () => {
    const out = decide(base({ command: 'journeys.enroll', actionClass: 'journey.live', impact: { people: 2000 }, approvable: false }));
    expect(out.decision).toBe('deny');
    expect(out.reasons.at(-1)).toContain('journeys.enroll cannot wait for an approval');
  });

  it('enforces the daily change limit', () => {
    const settings = autonomySettings({ limits: { changesPerDay: 10 } });
    expect(decide(base({ settings, counters: { changes: 9, messages: 0 } })).decision).toBe('allow');
    expect(decide(base({ settings, counters: { changes: 10, messages: 0 } })).decision).toBe('ask');
  });

  it('enforces the daily message limit for direct sends', () => {
    const settings = autonomySettings({ limits: { messagesPerDay: 5 } });
    const send = { command: 'messages.sendEmail', actionClass: 'send.direct' as const, impact: { people: 1 }, approvable: false, settings };
    expect(decide(base({ ...send, counters: { changes: 0, messages: 4 } })).decision).toBe('allow');
    expect(decide(base({ ...send, counters: { changes: 0, messages: 5 } })).decision).toBe('deny');
  });

  it('a workspace draft ceiling of 0 makes agents observe-only, with or without a mandate', () => {
    const settings = autonomySettings({ maxLevel: { draft: 0 } });
    expect(decide(base({ settings, actionClass: 'draft' })).decision).toBe('deny');
    expect(decide(base({ settings, actionClass: 'draft' })).reasons[0]).toContain('observe only');
    const levels = { draft: 1, 'site.content': 3 } as MandateView['levels'];
    const withMandate = decide(
      base({
        settings,
        actionClass: 'draft',
        mandate: {
          id: 'mnd_draft',
          version: 1,
          levels,
          scope: { segments: [], purposes: [], topics: [], channels: [], artifactTypes: [], artifacts: [] },
          limits: {},
          holdWindow: 'PT2H',
          independentCheck: false,
          guardrails: { window: 'P7D', minSent: 100 },
          purpose: 'Draft ceiling',
        },
      }),
    );
    expect(withMandate.decision).toBe('deny');
    // Reading is still allowed: a ceiling of 0 is observe-only, not switched off.
    expect(decide(base({ settings, actionClass: 'read' })).decision).toBe('allow');
  });

  it('propose-only lets agents draft but sends every other change to a person', () => {
    const settings = autonomySettings({ switch: 'propose_only' });
    expect(decide(base({ settings, actionClass: 'draft' })).decision).toBe('allow');
    expect(decide(base({ settings })).decision).toBe('ask');
    expect(decide(base({ settings, command: 'segments.refresh', actionClass: 'audience.publish', approvable: false })).decision).toBe(
      'deny',
    );
  });

  it('off leaves agents read-only', () => {
    const settings = autonomySettings({ switch: 'off' });
    expect(decide(base({ settings, actionClass: 'read' })).decision).toBe('allow');
    expect(decide(base({ settings, actionClass: 'draft' })).decision).toBe('deny');
    expect(decide(base({ settings })).decision).toBe('deny');
  });
});

describe('the policy engine with a mandate (#224)', () => {
  const mandate = (over: Partial<MandateView> = {}): MandateView => ({
    id: 'mnd_1',
    version: 1,
    levels: { 'send.broadcast': 3, 'content.publish': 3 },
    scope: {
      segments: ['seg_news'],
      purposes: ['marketing_email'],
      topics: ['newsletter'],
      channels: ['email'],
      artifactTypes: [],
      artifacts: [],
    },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: false,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'Send the weekly newsletter',
    ...over,
  });
  const settings = autonomySettings({ maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
  const send = (over: Partial<PolicyInput> = {}) =>
    decide(
      base({
        actionClass: 'send.broadcast',
        settings,
        mandate: mandate(),
        impact: {
          people: 400,
          touches: { segments: ['seg_news'], purposes: ['marketing_email'], topics: ['newsletter'], channels: ['email'] },
        },
        ...over,
      }),
    );

  it('level 3 inside the scope and limits runs autonomously', () => {
    expect(send()).toMatchObject({ decision: 'allow', autonomous: true, level: 3, mandate: { id: 'mnd_1', version: 1 } });
  });

  it('is capped by the workspace ceiling, whose default is a person', () => {
    expect(send({ settings: autonomySettings({}) })).toMatchObject({ decision: 'ask', level: 1 });
  });

  it('level 2 holds for the veto window', () => {
    const out = send({ mandate: mandate({ levels: { 'send.broadcast': 2 } }) });
    expect(out).toMatchObject({ decision: 'hold', level: 2 });
    expect(out.reasons[0]).toContain('PT2H');
  });

  it('anything outside the scope is only proposed', () => {
    const out = send({ impact: { people: 400, touches: { segments: ['seg_other'], channels: ['email'] } } });
    expect(out.decision).toBe('ask');
    expect(out.reasons).toContain('Audience seg_other is outside this agent’s mandate.');
  });

  it('a mandate limit drops one level, the workspace threshold goes to a person', () => {
    expect(send({ mandate: mandate({ limits: { recipientsPerSend: 300 } }) })).toMatchObject({ decision: 'hold', level: 2 });
    expect(
      send({ counters: { changes: 0, messages: 0, previousSendPeople: 300 }, mandate: mandate({ limits: { recipientGrowth: 1.2 } }) }),
    ).toMatchObject({
      decision: 'hold',
    });
    expect(send({ impact: { people: 5000, touches: { segments: ['seg_news'] } } })).toMatchObject({ decision: 'ask', level: 1 });
  });

  it('a guardrail breach goes to a person; outside working hours an irreversible action is held', () => {
    expect(send({ guardrailBreach: 'unsubscribe rate 1%' })).toMatchObject({ decision: 'ask', reasons: ['unsubscribe rate 1%'] });
    expect(send({ outsideHours: 'It is 23:00' })).toMatchObject({ decision: 'hold', level: 2 });
  });

  it('never makes settings or destructive changes autonomous, and refuses at level 0', () => {
    expect(send({ actionClass: 'settings', mandate: mandate({ levels: { settings: 3 } }) }).decision).toBe('ask');
    expect(send({ impact: { people: 1, needsPerson: 'Purposes always need a person.' } }).decision).toBe('ask');
    expect(send({ mandate: mandate({ levels: { 'send.broadcast': 0 } }) })).toMatchObject({ decision: 'deny', level: 0 });
  });

  it('a non-approvable action at level 2 is refused rather than held', () => {
    const out = send({
      actionClass: 'send.direct',
      approvable: false,
      mandate: mandate({ levels: { 'send.direct': 2 } }),
      settings: autonomySettings({ maxLevel: { 'send.direct': 3 } }),
    });
    expect(out.decision).toBe('deny');
  });
});

describe('audit fixes (#232, #246)', () => {
  const view = (over: Partial<MandateView> = {}): MandateView => ({
    id: 'mnd_1',
    version: 1,
    levels: { 'content.publish': 3 },
    scope: { segments: [], purposes: [], topics: [], channels: ['email'], artifactTypes: ['broadcast'], artifacts: ['bct_allowed'] },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: false,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'x',
    ...over,
  });
  const settings = autonomySettings({ maxLevel: { 'content.publish': 3, 'send.broadcast': 3 } });
  const publish = (artifacts: { id: string; type: string }[], over: Partial<MandateView> = {}) =>
    decide(base({ settings, mandate: view(over), impact: { touches: { artifacts } } }));

  it('enforces the artifact id list even when the type is allowed (#232)', () => {
    expect(publish([{ id: 'bct_other', type: 'broadcast' }]).decision).toBe('ask');
    expect(publish([{ id: 'bct_allowed', type: 'broadcast' }]).decision).toBe('allow');
    expect(publish([{ id: 'bct_allowed', type: 'journey' }]).decision).toBe('ask');
    // Each list alone restricts only its own dimension.
    expect(publish([{ id: 'bct_any', type: 'broadcast' }], { scope: { ...view().scope, artifacts: [] } }).decision).toBe('allow');
    expect(publish([{ id: 'bct_allowed', type: 'journey' }], { scope: { ...view().scope, artifactTypes: [] } }).decision).toBe('allow');
  });

  it('a mandate limit lowers 3 to a hold and 2 to propose, and never below propose (#246)', () => {
    const at = (level: number) =>
      decide(
        base({
          actionClass: 'send.broadcast',
          settings,
          mandate: view({
            levels: { 'send.broadcast': level },
            limits: { recipientsPerSend: 10 },
            scope: { ...view().scope, artifactTypes: [], artifacts: [] },
          }),
          impact: { people: 50, touches: { channels: ['email'] } },
        }),
      );
    expect(at(3)).toMatchObject({ decision: 'hold', level: 2 });
    expect(at(2)).toMatchObject({ decision: 'ask', level: 1 });
    expect(at(1)).toMatchObject({ decision: 'ask', level: 1 });
    expect(at(1).reasons.join(' ')).toContain('the mandate allows 10 per send');
  });
});

describe('the guardian’s cap (#253)', () => {
  const view = (over: Partial<MandateView> = {}): MandateView => ({
    id: 'mnd_1',
    version: 1,
    levels: { 'send.broadcast': 3, 'content.publish': 3 },
    scope: { segments: ['seg_news'], purposes: [], topics: [], channels: ['email'], artifactTypes: [], artifacts: [] },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: false,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'x',
    ...over,
  });
  const settings = autonomySettings({ maxLevel: { 'send.broadcast': 3, 'content.publish': 3 } });
  const send = { actionClass: 'send.broadcast' as const, impact: { people: 10, touches: { segments: ['seg_news'], channels: ['email'] } } };

  it('caps every class at its level, with the reason', () => {
    const guard = { cap: 1, reason: 'The guardian limited this agent: unsubscribes.' };
    expect(decide(base({ settings, mandate: view(), guard, ...send }))).toMatchObject({ decision: 'ask', level: 1 });
    expect(decide(base({ settings, mandate: view(), guard })).reasons).toContain(guard.reason);
  });

  it('holds irreversible classes only, when it caps them at 2', () => {
    const guard = { cap: 4, irreversibleCap: 2, reason: 'A send far larger than usual.' };
    expect(decide(base({ settings, mandate: view(), guard, ...send }))).toMatchObject({ decision: 'hold', level: 2 });
    expect(decide(base({ settings, mandate: view(), guard }))).toMatchObject({ decision: 'allow', level: 3 });
  });

  it('sends a change to a person when the agent has no mandate', () => {
    expect(decide(base({ guard: { cap: 1, reason: 'Capped.' } }))).toMatchObject({ decision: 'ask', reasons: ['Capped.'] });
    expect(decide(base({ guard: { cap: 4, irreversibleCap: 2, reason: 'Held.' } })).decision).toBe('allow');
  });
});

describe('shadow mode (#256)', () => {
  const view = (shadow: MandateView['shadow']): MandateView => ({
    id: 'mnd_s',
    version: 2,
    levels: { 'content.publish': 3, 'send.broadcast': 3 },
    scope: { segments: [], purposes: [], topics: [], channels: ['email'], artifactTypes: [], artifacts: [] },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: true,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'x',
    shadow,
  });

  it('records what the mandate would do and decides as without one', () => {
    // The ceiling is the default (a person), but a shadow level is judged as granted.
    const out = decide(base({ mandate: view(true) }));
    expect(out).toMatchObject({ decision: 'allow', shadow: { decision: 'allow', level: 3, mandateId: 'mnd_s', mandateVersion: 2 } });
    expect(out.mandate).toBeUndefined();
    expect(out.autonomous).toBeUndefined();
  });

  it('the applied decision follows the workspace rules, not the mandate', () => {
    const out = decide(base({ mandate: view(true), actionClass: 'send.broadcast', impact: { people: 5000 } }));
    expect(out.decision).toBe('ask');
    expect(out.shadow).toMatchObject({ decision: 'ask' });
    const within = decide(
      base({
        mandate: view(true),
        actionClass: 'send.broadcast',
        impact: { people: 50 },
        settings: autonomySettings({ switch: 'propose_only' }),
      }),
    );
    expect(within).toMatchObject({ decision: 'ask', shadow: { decision: 'ask' } });
  });

  it('only the listed classes run in shadow', () => {
    const settings = autonomySettings({ maxLevel: { 'content.publish': 3, 'send.broadcast': 3 } });
    expect(decide(base({ settings, mandate: view(['send.broadcast']) }))).toMatchObject({ decision: 'allow', autonomous: true });
    expect(decide(base({ settings, mandate: view(['send.broadcast']) })).shadow).toBeUndefined();
    expect(
      decide(base({ settings, mandate: view(['send.broadcast']), actionClass: 'send.broadcast', impact: { people: 5 } })).shadow,
    ).toMatchObject({
      decision: 'allow',
    });
  });
});

describe('learning rules (#257)', () => {
  const view = (learning: MandateView['learning']): MandateView => ({
    id: 'mnd_l',
    version: 1,
    levels: { 'journey.live': 3, 'send.broadcast': 3, 'experience.live': 3 },
    scope: { segments: [], purposes: [], topics: [], channels: ['email'], artifactTypes: [], artifacts: [] },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: false,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'x',
    learning,
  });
  const settings = autonomySettings({ maxLevel: { 'journey.live': 3, 'send.broadcast': 3, 'experience.live': 3 } });
  const run = (
    actionClass: 'journey.live' | 'send.broadcast' | 'experience.live',
    learning: NonNullable<PolicyInput['impact']['learning']>,
  ) =>
    decide(
      base({
        settings,
        actionClass,
        mandate: view({ journeyControlPercent: 10, broadcastHoldout: true, experienceHoldoutPercent: 5 }),
        impact: { people: 10, learning },
      }),
    );

  it('a journey needs its control group', () => {
    expect(run('journey.live', [{ id: 'jrn_1', type: 'journey', controlPercent: 5 }])).toMatchObject({ decision: 'ask', level: 1 });
    expect(run('journey.live', [{ id: 'jrn_1', type: 'journey', controlPercent: 10 }]).decision).toBe('allow');
  });

  it('a broadcast needs a holdout or a subject test', () => {
    expect(run('send.broadcast', [{ id: 'bct_1', type: 'broadcast', controlPercent: 0 }]).reasons[0]).toContain('neither a holdout');
    expect(run('send.broadcast', [{ id: 'bct_1', type: 'broadcast', controlPercent: 0, subjectTest: true }]).decision).toBe('allow');
    expect(run('send.broadcast', [{ id: 'bct_1', type: 'broadcast', controlPercent: 10 }]).decision).toBe('allow');
  });

  it('an experience needs its holdout; without rules nothing is required', () => {
    expect(run('experience.live', [{ id: 'exp_1', type: 'experience', controlPercent: 0 }]).decision).toBe('ask');
    expect(
      decide(
        base({
          settings,
          actionClass: 'journey.live',
          mandate: view({}),
          impact: { people: 10, learning: [{ id: 'j', type: 'journey', controlPercent: 0 }] },
        }),
      ).decision,
    ).toBe('allow');
  });

  it('an experience needs a real, guarded ramp when the mandate requires one (#427, #475)', () => {
    const ramped = (learning: MandateView['learning'], ramp?: { firstStep?: number; steps?: number; guardrail?: boolean }) =>
      decide(
        base({
          settings,
          actionClass: 'experience.live',
          mandate: view(learning),
          impact: {
            people: 10,
            learning: [
              {
                id: 'exp_1',
                type: 'experience',
                controlPercent: 0,
                rampFirstStep: ramp?.firstStep ?? null,
                rampSteps: ramp?.steps ?? null,
                rampGuardrail: ramp?.guardrail ?? false,
              },
            ],
          },
        }),
      );
    const real = { firstStep: 10, steps: 3, guardrail: true };
    expect(ramped({ experienceRamp: true }).decision).toBe('ask');
    expect(ramped({ experienceRamp: true }).reasons.join(' ')).toContain('ramp');
    // A one-step 100% rollout is not a ramp: it serves everyone at once.
    const oneStep = ramped({ experienceRamp: true }, { firstStep: 100, steps: 1, guardrail: true });
    expect(oneStep.decision).toBe('ask');
    expect(oneStep.reasons.join(' ')).toContain('two steps');
    // Two steps that start at 100% are not gradual either.
    expect(ramped({ experienceRamp: true }, { firstStep: 100, steps: 2, guardrail: true }).decision).toBe('ask');
    // A ramp without a guardrail cannot pause itself when the change hurts.
    const unguarded = ramped({ experienceRamp: true }, { firstStep: 10, steps: 2 });
    expect(unguarded.decision).toBe('ask');
    expect(unguarded.reasons.join(' ')).toContain('guardrail');
    expect(ramped({ experienceRamp: true }, real).decision).toBe('allow');
    expect(ramped({ experienceRamp: 10 }, { ...real, firstStep: 5 }).decision).toBe('ask');
    expect(ramped({ experienceRamp: 10 }, real).decision).toBe('allow');
  });
});

describe('level 4, run the loop (#309)', () => {
  const view = (level: number): MandateView => ({
    id: 'mnd_l4',
    version: 1,
    levels: { 'content.publish': level },
    scope: { segments: [], purposes: [], topics: [], channels: ['email'], artifactTypes: ['note'], artifacts: ['not_known'] },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: false,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'x',
  });
  const loops = autonomySettings({ allowLoops: true, maxLevel: { 'content.publish': 4 } });
  const publish = (level: number, artifact: { id: string; type: string; created?: boolean }, settings = loops) =>
    decide(base({ settings, mandate: view(level), impact: { touches: { artifacts: [artifact] } } }));

  it('creates new artifacts of an allowed type without a grant for each', () => {
    expect(publish(4, { id: 'not_new', type: 'note', created: true })).toMatchObject({ decision: 'allow', level: 4, autonomous: true });
  });

  it('still keeps changes to existing artifacts and other types to the scope', () => {
    expect(publish(4, { id: 'not_other', type: 'note', created: false }).decision).toBe('ask');
    expect(publish(4, { id: 'jrn_new', type: 'journey', created: true }).decision).toBe('ask');
  });

  it('level 3 does not create outside the list, and without allowLoops level 4 is level 3', () => {
    expect(publish(3, { id: 'not_new', type: 'note', created: true }).decision).toBe('ask');
    const noLoops = autonomySettings({ allowLoops: false, maxLevel: { 'content.publish': 4 } });
    expect(publish(4, { id: 'not_new', type: 'note', created: true }, noLoops)).toMatchObject({ decision: 'ask', level: 1 });
  });
});

describe('several agents in one workspace (#426)', () => {
  const owned = {
    agentId: 'agt_other',
    agentName: 'Newsletter agent',
    active: true,
    artifactId: 'not_1',
    artifactName: 'Weekly issue',
  };
  const level3 = autonomySettings({ maxLevel: { 'content.publish': 3 } });
  const view = (): MandateView => ({
    id: 'mnd_coord',
    version: 1,
    levels: { 'content.publish': 3 },
    scope: { segments: [], purposes: [], topics: [], channels: ['email'], artifactTypes: [], artifacts: [] },
    limits: {},
    holdWindow: 'PT2H',
    independentCheck: false,
    guardrails: { window: 'P7D', minSent: 100 },
    purpose: 'x',
  });

  it('asks a person, without a mandate, when another active agent owns the artifact', () => {
    const out = decide(base({ ownership: owned }));
    expect(out.decision).toBe('ask');
    expect(out.reasons[0]).toBe('“Weekly issue” is owned by agent Newsletter agent.');
  });

  it('caps a mandate at level 1 and names the owner', () => {
    const out = decide(base({ settings: level3, mandate: view(), ownership: owned }));
    expect(out).toMatchObject({ decision: 'ask', level: 1 });
    expect(out.reasons).toContain('“Weekly issue” is owned by agent Newsletter agent.');
  });

  it('reports an inactive owner but does not block', () => {
    const out = decide(base({ settings: level3, mandate: view(), ownership: { ...owned, active: false } }));
    expect(out).toMatchObject({ decision: 'allow', level: 3, autonomous: true });
    expect(out.reasons.join(' ')).toContain('which is not active');
  });

  it('caps a second agent when another has a pending change, with and without a mandate', () => {
    const conflict = '“Weekly issue” already has an open approval request from agent Journey agent.';
    expect(decide(base({ conflicts: [conflict] }))).toMatchObject({ decision: 'ask', reasons: [conflict] });
    expect(decide(base({ settings: level3, mandate: view(), conflicts: [conflict] }))).toMatchObject({ decision: 'ask', level: 1 });
  });
});
