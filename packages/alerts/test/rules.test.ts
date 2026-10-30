import { describe, expect, it } from 'vitest';
import {
  AlertChannels,
  DEFAULT_JOURNEY_WINDOW,
  DEFAULT_WINDOW,
  type DeliverabilityConfig,
  isRatioMetric,
  type JourneyErrorsConfig,
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  metricId,
  metricLabel,
  minimumIntervalMs,
  parseAlertConfig,
  type SignupDropConfig,
  windowLabel,
  windowMs,
} from '../src/rules';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const JOURNEY = `jrn_${'a'.repeat(32)}`;

const deliverability = (raw: unknown) => parseAlertConfig('deliverability', raw) as DeliverabilityConfig;
const signupDrop = (raw: unknown) => parseAlertConfig('signup_drop', raw) as SignupDropConfig;
const journeyErrors = (raw: unknown) => parseAlertConfig('journey_errors', raw) as JourneyErrorsConfig;

describe('alert windows', () => {
  it('reads hour and day durations in milliseconds', () => {
    expect(windowMs('PT1H')).toBe(HOUR);
    expect(windowMs('PT24H')).toBe(DAY);
    expect(windowMs('PT168H')).toBe(7 * DAY);
    expect(windowMs('P1D')).toBe(DAY);
    expect(windowMs('P7D')).toBe(7 * DAY);
    expect(MIN_WINDOW_MS).toBe(HOUR);
    expect(MAX_WINDOW_MS).toBe(7 * DAY);
  });

  it('rejects anything that is not a whole-hour or whole-day duration', () => {
    for (const bad of ['', '24h', 'P', 'PT', 'PT0H', 'P0D', 'PT1M', 'PT1H30M', 'P1W', 'P-1D', 'pt1h', '  PT1H']) {
      expect(() => windowMs(bad), bad).toThrow(/is not a duration like PT1H or P7D/);
    }
  });

  it('labels a duration the way people read it', () => {
    expect(windowLabel('PT1H')).toBe('1 hour');
    expect(windowLabel('PT2H')).toBe('2 hours');
    expect(windowLabel('P1D')).toBe('1 day');
    expect(windowLabel('PT24H')).toBe('1 day');
    expect(windowLabel('PT25H')).toBe('25 hours');
    expect(windowLabel('P7D')).toBe('7 days');
  });

  it('caps every rule at no more than four checks per window', () => {
    expect(minimumIntervalMs({ window: 'PT1H', dropPercent: 50, minPrevious: 10 })).toBe(15 * 60_000);
    expect(minimumIntervalMs({ window: 'PT2H', dropPercent: 50, minPrevious: 10 })).toBe(30 * 60_000);
    expect(minimumIntervalMs({ window: 'PT4H', dropPercent: 50, minPrevious: 10 })).toBe(HOUR);
    expect(minimumIntervalMs({ window: 'P1D', dropPercent: 50, minPrevious: 10 })).toBe(HOUR);
    expect(minimumIntervalMs({ window: 'P7D', dropPercent: 50, minPrevious: 10 })).toBe(HOUR);
  });
});

describe('deliverability rule configuration', () => {
  it('defaults to a 24-hour bounce rate with a 5% threshold and 100 sent messages', () => {
    expect(deliverability({})).toEqual({
      metric: 'bounce',
      window: DEFAULT_WINDOW,
      threshold: 0.05,
      minSent: 100,
    });
  });

  it('uses the tighter 0.1% default when it watches complaints', () => {
    expect(deliverability({ metric: 'complaint' })).toMatchObject({ metric: 'complaint', threshold: 0.001 });
  });

  it('keeps an explicit threshold, metric, window and minimum volume', () => {
    expect(deliverability({ metric: 'complaint', window: 'P2D', threshold: 0.01, minSent: 5000 })).toEqual({
      metric: 'complaint',
      window: 'P2D',
      threshold: 0.01,
      minSent: 5000,
    });
  });

  it('rejects invalid values and unknown keys', () => {
    for (const raw of [
      { metric: 'open' },
      { threshold: 0 },
      { threshold: -0.1 },
      { threshold: 1.01 },
      { minSent: 0 },
      { minSent: 1.5 },
      { minSent: 10_000_001 },
      { window: 'P8D' },
      { threshold: 0.05, recipient: 'ada@example.com' },
    ]) {
      expect(() => parseAlertConfig('deliverability', raw), JSON.stringify(raw)).toThrow(
        'The configuration for a deliverability alert is not valid.',
      );
    }
    expect(deliverability({ threshold: 1 }).threshold).toBe(1);
    expect(deliverability({ minSent: 1 }).minSent).toBe(1);
    expect(deliverability({ minSent: 10_000_000 }).minSent).toBe(10_000_000);
  });
});

describe('signup drop rule configuration', () => {
  it('defaults to a 50% drop over 24 hours with at least 10 signups before', () => {
    expect(signupDrop({})).toEqual({ window: DEFAULT_WINDOW, dropPercent: 50, minPrevious: 10 });
  });

  it('accepts the edges of the percentage and volume ranges', () => {
    expect(signupDrop({ dropPercent: 0.01, minPrevious: 1 })).toMatchObject({ dropPercent: 0.01, minPrevious: 1 });
    expect(signupDrop({ dropPercent: 100, minPrevious: 1_000_000 })).toMatchObject({ dropPercent: 100, minPrevious: 1_000_000 });
  });

  it('rejects invalid values and unknown keys', () => {
    for (const raw of [
      { dropPercent: 0 },
      { dropPercent: 100.1 },
      { minPrevious: 0 },
      { minPrevious: 1_000_001 },
      { minPrevious: 2.5 },
      { dropPercent: 10, threshold: 0.05 },
    ]) {
      expect(() => parseAlertConfig('signup_drop', raw), JSON.stringify(raw)).toThrow(
        'The configuration for a signup_drop alert is not valid.',
      );
    }
  });
});

describe('journey errors rule configuration', () => {
  it('defaults to more than five failures in the last hour across every journey', () => {
    expect(journeyErrors({})).toEqual({ window: DEFAULT_JOURNEY_WINDOW, threshold: 5 });
    expect(DEFAULT_JOURNEY_WINDOW).toBe('PT1H');
  });

  it('accepts a journey filter and the threshold edges', () => {
    expect(journeyErrors({ journeyId: JOURNEY, threshold: 1, window: 'P1D' })).toEqual({
      window: 'P1D',
      threshold: 1,
      journeyId: JOURNEY,
    });
    expect(journeyErrors({ threshold: 1_000_000 }).threshold).toBe(1_000_000);
  });

  it('rejects an invalid journey id, threshold or unknown key', () => {
    for (const raw of [
      { journeyId: 'jrn_1' },
      { journeyId: `bct_${'a'.repeat(32)}` },
      { threshold: 0 },
      { threshold: 1_000_001 },
      { threshold: 5, metric: 'bounce' },
    ]) {
      expect(() => parseAlertConfig('journey_errors', raw), JSON.stringify(raw)).toThrow(
        'The configuration for a journey_errors alert is not valid.',
      );
    }
  });

  it('treats a missing configuration as an empty object and reports the field errors', () => {
    expect(journeyErrors(null)).toEqual({ window: 'PT1H', threshold: 5 });
    try {
      parseAlertConfig('deliverability', { minSent: 0 });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toMatchObject({ name: 'AppError', code: 'invalid_input' });
      expect((error as { details?: unknown }).details).toBeDefined();
    }
  });

  it.fails('reports a malformed window as a structured validation error (#173)', () => {
    // Window is a regex plus a refine, and the refine calls windowMs, which throws for any string
    // the regex would reject (P0D, PT25H30M, …). The throw escapes Zod's safeParse, so callers get
    // the low-level "not a duration" AppError without the field path or the other field errors
    // that safeParse would report. Validation should return issues, not throw from inside refine.
    expect(() => parseAlertConfig('signup_drop', { window: 'P0D' })).toThrow('The configuration for a signup_drop alert is not valid.');
    expect(() => parseAlertConfig('journey_errors', { window: 'PT25H30M' })).toThrow(
      'The configuration for a journey_errors alert is not valid.',
    );
  });
});

describe('alert metrics', () => {
  it('names the measure people read and the metric the query layer runs', () => {
    expect(metricLabel('deliverability', deliverability({ metric: 'bounce' }))).toBe('Bounce rate');
    expect(metricLabel('deliverability', deliverability({ metric: 'complaint' }))).toBe('Complaint rate');
    expect(metricLabel('signup_drop', signupDrop({}))).toBe('Confirmed signups');
    expect(metricLabel('journey_errors', journeyErrors({}))).toBe('Failed journey steps');

    expect(metricId('deliverability', deliverability({ metric: 'bounce' }))).toBe('email.bounce_rate');
    expect(metricId('deliverability', deliverability({ metric: 'complaint' }))).toBe('email.complaint_rate');
    expect(metricId('signup_drop', signupDrop({}))).toBe('conversions');
    expect(metricId('journey_errors', journeyErrors({}))).toBe('journey.failed');
  });

  it('formats only deliverability as a ratio', () => {
    expect(isRatioMetric('deliverability')).toBe(true);
    expect(isRatioMetric('signup_drop')).toBe(false);
    expect(isRatioMetric('journey_errors')).toBe(false);
  });
});

describe('alert channels', () => {
  it('accepts webhook and member channels', () => {
    expect(AlertChannels.safeParse([{ type: 'webhook', webhookId: `whk_${'a'.repeat(32)}` }]).success).toBe(true);
    expect(AlertChannels.safeParse([{ type: 'email', userIds: ['usr_1', 'usr_2'] }]).success).toBe(true);
    expect(
      AlertChannels.safeParse([
        { type: 'webhook', webhookId: `whk_${'a'.repeat(32)}` },
        { type: 'email', userIds: ['usr_1'] },
      ]).success,
    ).toBe(true);
  });

  it('rejects an empty list, too many channels, bad ids and empty member lists', () => {
    expect(AlertChannels.safeParse([]).success).toBe(false);
    expect(AlertChannels.safeParse(Array(21).fill({ type: 'email', userIds: ['usr_1'] })).success).toBe(false);
    expect(AlertChannels.safeParse([{ type: 'webhook', webhookId: 'whk_1' }]).success).toBe(false);
    expect(AlertChannels.safeParse([{ type: 'email', userIds: [] }]).success).toBe(false);
    expect(AlertChannels.safeParse([{ type: 'email', userIds: Array(51).fill('usr_1') }]).success).toBe(false);
    expect(AlertChannels.safeParse([{ type: 'slack', channel: '#alerts' }]).success).toBe(false);
  });

  it('rejects the same webhook or the same member list twice', () => {
    const webhook = { type: 'webhook' as const, webhookId: `whk_${'b'.repeat(32)}` };
    expect(AlertChannels.safeParse([webhook, webhook]).success).toBe(false);
    expect(
      AlertChannels.safeParse([
        { type: 'email', userIds: ['usr_1', 'usr_2'] },
        { type: 'email', userIds: ['usr_1', 'usr_2'] },
      ]).success,
    ).toBe(false);
  });

  it.fails('treats the same member list in a different order as the same channel (#173)', () => {
    // Duplicate detection keys an e-mail channel by userIds.join(','), so the same people in a
    // different order look like two channels. notifyChannels then de-duplicates the addresses, but
    // the rule's stored channel list still contains the same audience twice and the UI shows two
    // entries for it.
    expect(
      AlertChannels.safeParse([
        { type: 'email', userIds: ['usr_1', 'usr_2'] },
        { type: 'email', userIds: ['usr_2', 'usr_1'] },
      ]).success,
    ).toBe(false);
  });
});
