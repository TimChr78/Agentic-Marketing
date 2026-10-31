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
    expect(run('journey.live', [{ id: 'jny_1', type: 'journey', controlPercent: 5 }])).toMatchObject({ decision: 'ask', level: 1 });
    expect(run('journey.live', [{ id: 'jny_1', type: 'journey', controlPercent: 10 }]).decision).toBe('allow');
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
});
