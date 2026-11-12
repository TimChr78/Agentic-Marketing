import { describe, expect, it } from 'vitest';
import { summaryWindow } from '../src/campaignSummary';

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
