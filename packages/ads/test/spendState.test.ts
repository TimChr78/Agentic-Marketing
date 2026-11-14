import { describe, expect, it } from 'vitest';
import {
  addIncomplete,
  completeInterval,
  incompleteInWindow,
  incompleteSpendFor,
  incompleteSpendNote,
  normalizeIntervals,
  parseSpendState,
  SPEND_STATE_MAX_INTERVALS,
} from '../src/spendState';

// #917 review round 2: one truncated import must not be overwritten by the next complete refresh.
// The state is a list of closed date ranges, so a later complete read removes exactly the days it
// covered (splitting when it covers the middle) and a report only warns for its own window.
describe('spend state intervals', () => {
  it('sorts and merges overlapping and adjacent ranges', () => {
    expect(
      normalizeIntervals([
        { from: '2026-03-05', to: '2026-03-07' },
        { from: '2026-03-01', to: '2026-03-02' },
        { from: '2026-03-03', to: '2026-03-04' },
      ]),
    ).toEqual([{ from: '2026-03-01', to: '2026-03-07' }]);
    expect(
      normalizeIntervals([
        { from: '2026-03-01', to: '2026-03-02' },
        { from: '2026-03-05', to: '2026-03-06' },
      ]),
    ).toEqual([
      { from: '2026-03-01', to: '2026-03-02' },
      { from: '2026-03-05', to: '2026-03-06' },
    ]);
  });

  it('ignores malformed ranges and reversed bounds', () => {
    expect(
      normalizeIntervals([
        { from: 'soon', to: '2026-03-02' },
        { from: '2026-03-05', to: '2026-03-01' },
        { from: '2026-03-02', to: '2026-03-02' },
      ]),
    ).toEqual([{ from: '2026-03-02', to: '2026-03-02' }]);
    expect(parseSpendState({ incomplete: [{ from: '2026-03-02', to: '2026-03-02' }] })).toEqual({
      incomplete: [{ from: '2026-03-02', to: '2026-03-02' }],
    });
    expect(parseSpendState({ incomplete: 'nope' })).toEqual({});
    expect(parseSpendState(null)).toEqual({});
  });

  it('keeps one covering range when the list would exceed its cap, never dropping a day', () => {
    const many = Array.from({ length: SPEND_STATE_MAX_INTERVALS + 2 }, (_, i) => ({
      from: `2026-01-${String(i * 2 + 1).padStart(2, '0')}`,
      to: `2026-01-${String(i * 2 + 1).padStart(2, '0')}`,
    }));
    const merged = normalizeIntervals(many);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ from: '2026-01-01', to: many[many.length - 1]!.to });
  });

  it('subtracts a complete read, splitting a stored range it covers in the middle', () => {
    const state = { incomplete: [{ from: '2026-01-01', to: '2026-03-31' }] };
    expect(completeInterval(state, { from: '2026-03-29', to: '2026-03-31' })).toEqual({
      incomplete: [{ from: '2026-01-01', to: '2026-03-28' }],
    });
    expect(completeInterval(state, { from: '2026-02-10', to: '2026-02-20' })).toEqual({
      incomplete: [
        { from: '2026-01-01', to: '2026-02-09' },
        { from: '2026-02-21', to: '2026-03-31' },
      ],
    });
    expect(completeInterval(state, { from: '2026-01-01', to: '2026-03-31' })).toEqual({});
    expect(completeInterval(state, { from: '2025-12-01', to: '2025-12-31' })).toEqual(state);
  });

  it('adds a truncated window and exposes only the intersection with a report', () => {
    let state = addIncomplete({}, { from: '2026-01-01', to: '2026-03-31' });
    state = addIncomplete(state, { from: '2026-01-05', to: '2026-01-10' });
    expect(state.incomplete).toEqual([{ from: '2026-01-01', to: '2026-03-31' }]);
    expect(incompleteInWindow(state, { from: '2026-03-29', to: '2026-03-31' })).toEqual([{ from: '2026-03-29', to: '2026-03-31' }]);
    expect(incompleteInWindow(state, { from: '2026-04-01', to: '2026-04-30' })).toEqual([]);
  });

  it('reports incomplete spend per platform and names the range in the note', () => {
    const meta = { connector: 'meta_ads', spendState: { incomplete: [{ from: '2026-01-01', to: '2026-03-31' }] } };
    const google = { connector: 'google_ads', spendState: { incomplete: [{ from: '2026-01-01', to: '2026-01-31' }] } };
    const window = { since: '2026-01-01', until: '2026-01-31' };
    expect(incompleteSpendFor([meta, google], window)).toEqual([
      { platform: 'meta', intervals: [{ from: '2026-01-01', to: '2026-01-31' }] },
      { platform: 'google', intervals: [{ from: '2026-01-01', to: '2026-01-31' }] },
    ]);
    expect(incompleteSpendFor([meta, google], { ...window, platform: 'meta' }).map((entry) => entry.platform)).toEqual(['meta']);
    expect(incompleteSpendFor([meta], { since: '2026-04-01', until: '2026-04-30' })).toEqual([]);
    const note = incompleteSpendNote(incompleteSpendFor([meta], window));
    expect(note).toContain('meta 2026-01-01 to 2026-01-31');
    expect(note).toContain('CPA is understated');
    expect(incompleteSpendNote([])).toBeNull();
  });
});
