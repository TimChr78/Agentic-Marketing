import { describe, expect, it } from 'vitest';
import { campaignNotStarted, summaryWindow } from '../src/campaignSummary';

// #747: a campaign whose recorded start is after the requested `to` has no sends in that window,
// whether or not it has sent later. The default `from` must become an empty window instead of the
// reversed-window error the handler raises for an explicit from > to.

const NOW = '2026-12-10T00:00:00.000Z';
const TO = '2026-11-30T00:00:00.000Z';
const STARTS_AT = '2026-12-01T00:00:00.000Z';

describe('campaign summary window (#747)', () => {
  it('returns an empty window when the campaign start is after the requested to', () => {
    expect(summaryWindow({ to: TO, startsAt: STARTS_AT }, NOW, { allowFutureStart: false })).toEqual({
      from: TO,
      to: TO,
      clamped: false,
    });
  });

  it('does not depend on the allowFutureStart hint for a start after to', () => {
    expect(summaryWindow({ to: TO, startsAt: STARTS_AT }, NOW, { allowFutureStart: true })).toEqual({
      from: TO,
      to: TO,
      clamped: false,
    });
  });

  it('keeps the normal default window when the campaign did start before to', () => {
    expect(summaryWindow({ to: TO, startsAt: '2026-11-01T00:00:00.000Z' }, NOW)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: TO,
      clamped: false,
    });
  });

  it('still rejects an explicit from after to', () => {
    expect(() => summaryWindow({ from: '2026-12-02T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', startsAt: STARTS_AT }, NOW)).toThrow(
      /from must be before to/,
    );
  });

  it('accepts an explicit from equal to to', () => {
    expect(summaryWindow({ from: TO, to: TO, startsAt: STARTS_AT }, NOW)).toEqual({ from: TO, to: TO, clamped: false });
  });
});

describe('readiness and the default window follow real sends (0.14.10 review)', () => {
  it('is not "not started" when the campaign sent inside an explicit window before its planned start', () => {
    // Sent on 1 November, startsAt edited to 10 November, queried for 1–5 November.
    expect(
      campaignNotStarted({ published: true, sendingMembers: 1, firstSendAt: '2026-11-01T09:00:00.000Z', to: '2026-11-05T00:00:00.000Z' }),
    ).toBe(false);
  });

  it('is "not started" when nothing was sent on or before to', () => {
    expect(
      campaignNotStarted({ published: true, sendingMembers: 1, firstSendAt: '2026-12-02T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }),
    ).toBe(true);
    expect(campaignNotStarted({ published: true, sendingMembers: 1, firstSendAt: null, to: '2026-11-30T00:00:00.000Z' })).toBe(true);
    expect(
      campaignNotStarted({ published: false, sendingMembers: 1, firstSendAt: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }),
    ).toBe(true);
  });

  it('starts the default window at the first send when it precedes the planned start', () => {
    expect(
      summaryWindow(
        { to: '2026-11-05T00:00:00.000Z', startsAt: '2026-11-10T00:00:00.000Z', firstSendAt: '2026-11-01T09:00:00.000Z' },
        '2026-11-20T00:00:00.000Z',
      ),
    ).toEqual({ from: '2026-11-01T09:00:00.000Z', to: '2026-11-05T00:00:00.000Z', clamped: false });
  });
});
