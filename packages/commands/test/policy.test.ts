import { describe, expect, it } from 'vitest';
import { autonomySettings, decide, type PolicyInput } from '../src/policy';

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
