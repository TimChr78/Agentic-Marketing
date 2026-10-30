import type { AlertNotification } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { alertPayload, mergeNotifications, type NotifyInput } from '../src/notify';
import type { DeliverabilityConfig, JourneyErrorsConfig, SignupDropConfig } from '../src/rules';

const RULE_ID = `alr_${'a'.repeat(32)}`;
const WEBHOOK_ID = `whk_${'b'.repeat(32)}`;
const at = new Date('2026-10-30T09:00:00.000Z');

const bounce: DeliverabilityConfig = { metric: 'bounce', window: 'PT24H', threshold: 0.05, minSent: 100 };
const signups: SignupDropConfig = { window: 'P1D', dropPercent: 50, minPrevious: 20 };
const journey: JourneyErrorsConfig = { window: 'PT1H', threshold: 5, journeyId: `jrn_${'c'.repeat(32)}` };

const input = (overrides: Partial<NotifyInput> = {}): NotifyInput => ({
  workspace: { id: 'ws_01', name: 'Ada’s workspace' },
  rule: { id: RULE_ID, name: 'Bounce rate', kind: 'deliverability', config: bounce },
  eventId: 'evt_1',
  event: 'firing',
  value: 0.08,
  threshold: 0.05,
  window: 'PT24H',
  now: at,
  ...overrides,
});

const notification = (overrides: Partial<AlertNotification> = {}): AlertNotification => ({
  event: 'firing',
  channel: 'webhook',
  target: WEBHOOK_ID,
  at: at.toISOString(),
  status: 'sent',
  ...overrides,
});

describe('alert webhook payload', () => {
  it('carries the rule, the measure and the numbers, never a person', () => {
    expect(alertPayload(input(), 'https://admin.example.com/insights/alerts?rule=alr_a')).toEqual({
      type: 'alert.firing',
      rule: { id: RULE_ID, name: 'Bounce rate', kind: 'deliverability', config: bounce },
      metric: 'Bounce rate',
      measure: 'email.bounce_rate',
      value: 0.08,
      threshold: 0.05,
      window: 'PT24H',
      workspace: { id: 'ws_01', name: 'Ada’s workspace' },
      url: 'https://admin.example.com/insights/alerts?rule=alr_a',
      occurredAt: '2026-10-30T09:00:00.000Z',
    });
  });

  it('includes the previous window count when there is one, including zero', () => {
    const payload = alertPayload(
      input({ rule: { id: RULE_ID, name: 'Signup drop', kind: 'signup_drop', config: signups }, event: 'resolved', value: 3, previous: 0 }),
      'https://admin.example.com/insights/alerts',
    );
    expect(payload).toMatchObject({ type: 'alert.resolved', metric: 'Confirmed signups', measure: 'conversions', previous: 0 });
  });

  it('names a journey-error rule’s measure and keeps its window', () => {
    const payload = alertPayload(
      input({
        rule: { id: RULE_ID, name: 'Journey errors', kind: 'journey_errors', config: journey },
        value: 6,
        threshold: 5,
        window: 'PT1H',
      }),
      'https://admin.example.com/insights/alerts',
    );
    expect(payload).toMatchObject({ metric: 'Failed journey steps', measure: 'journey.failed', value: 6, threshold: 5 });
  });
});

describe('notification merging', () => {
  it('keeps earlier notifications and appends new channels', () => {
    const existing = [notification(), notification({ channel: 'email', target: 'usr_1' })];
    const merged = mergeNotifications(existing, [notification({ target: WEBHOOK_ID, status: 'sent' })]);
    expect(merged).toHaveLength(2);
    expect(merged).toEqual(existing);
  });

  it('replaces the entry for the same event, channel and target', () => {
    const existing = [notification({ status: 'failed', error: 'timeout' })];
    const merged = mergeNotifications(existing, [notification({ status: 'sent', deliveryId: 'dlv_1' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ status: 'sent', deliveryId: 'dlv_1' });
    expect(merged[0]?.error).toBeUndefined();
  });

  it('keeps the firing and the resolved notification for the same channel', () => {
    const firing = notification();
    const resolved = notification({ event: 'resolved' });
    const merged = mergeNotifications([firing], [resolved]);
    expect(merged.map((n) => n.event)).toEqual(['firing', 'resolved']);
  });

  it('treats a different target as a different notification', () => {
    const merged = mergeNotifications([notification()], [notification({ target: `whk_${'d'.repeat(32)}` })]);
    expect(merged).toHaveLength(2);
  });
});
