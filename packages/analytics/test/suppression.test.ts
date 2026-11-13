import { complementarySuppression } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import type { CompiledQuery } from '../src/compile';
import { suppressRows } from '../src/query';
import { MEASURES } from '../src/registry';

// Complementary suppression (#692): one hidden row beside a visible total is recoverable by
// subtraction, so the smallest visible row is hidden with it. These tests use the query layer's
// row shaper directly: the SQL and ClickHouse round trip are covered by the server test.

const measure = MEASURES['email.sent']!;

const compiled = (overrides: Partial<Pick<CompiledQuery, 'revenueKAlias' | 'hasNonTimeDimension'>> = {}) => ({
  outputs: [
    { kind: 'dimension' as const, dimension: 'template' as const, alias: 'dim_template' },
    { kind: 'measure' as const, measure, alias: 'm_sent' },
  ],
  kAlias: 'k_group',
  hasNonTimeDimension: true,
  ...overrides,
});

const row = (template: string, sent: number, group: number) => ({ dim_template: template, m_sent: sent, k_group: group });

const visibleSum = (rows: (string | number | null)[][]) => rows.reduce((sum, r) => sum + (typeof r[1] === 'number' ? r[1] : 0), 0);

describe('complementary suppression', () => {
  it('hides the smallest visible row when exactly one row is below k', () => {
    // T1 16, T2 6, T3 6, T4 3 (below k). A reader knows the total is 31, so leaving T2 and T3
    // visible would give T4 = 31 - 16 - 6 - 6 = 3. Hiding T2 too leaves only 6 + 3 = 9.
    const shaped = suppressRows([row('T1', 16, 16), row('T2', 6, 6), row('T3', 6, 6), row('T4', 3, 3)], compiled());

    expect(shaped.rows).toEqual([
      ['T1', 16],
      ['T2', null],
      ['T3', 6],
      ['T4', null],
    ]);
    expect(shaped.suppressed).toBe(2);
    expect(shaped.complementary).toBe(true);
    // Total minus visible rows is the sum of the hidden rows, not either one of them.
    expect(31 - visibleSum(shaped.rows)).toBe(9);
  });

  it('resolves a tie by the first row in the result order', () => {
    // T2 and T3 both have six people; the first in the (sorted) result is the complementary row.
    const shaped = suppressRows([row('T1', 16, 16), row('T2', 6, 6), row('T3', 6, 6), row('T4', 3, 3)], compiled());
    expect(shaped.rows[1]).toEqual(['T2', null]);
    expect(shaped.rows[2]).toEqual(['T3', 6]);

    expect(
      complementarySuppression([
        { group: 3, hidden: true },
        { group: 6, hidden: false },
        { group: 6, hidden: false },
      ]),
    ).toBe(1);
    // A lower group later in the list wins over a higher one earlier, and only the first tie does.
    expect(
      complementarySuppression([
        { group: 4, hidden: true },
        { group: 6, hidden: false },
        { group: 5, hidden: false },
      ]),
    ).toBe(2);
  });

  it('adds nothing when two rows are already below k', () => {
    const shaped = suppressRows([row('T1', 16, 16), row('T2', 6, 6), row('T3', 3, 3), row('T4', 2, 2)], compiled());

    expect(shaped.rows).toEqual([
      ['T1', 16],
      ['T2', 6],
      ['T3', null],
      ['T4', null],
    ]);
    expect(shaped.suppressed).toBe(2);
    expect(shaped.complementary).toBe(false);
    expect(
      complementarySuppression([
        { group: 3, hidden: true },
        { group: 2, hidden: true },
      ]),
    ).toBeNull();
  });

  it('adds nothing when no row is below k', () => {
    const shaped = suppressRows([row('T1', 16, 16), row('T2', 6, 6)], compiled());
    expect(shaped.rows).toEqual([
      ['T1', 16],
      ['T2', 6],
    ]);
    expect(shaped.suppressed).toBe(0);
    expect(shaped.complementary).toBe(false);
  });

  it('never picks a row with nobody in it, because hiding zero protects nobody', () => {
    // A member that never sent is a visible zero (the query layer already hides a zero group as
    // below k). Hiding the zero instead of the 10 would leave the hidden row derivable.
    expect(
      complementarySuppression([
        { group: 4, hidden: true },
        { group: 10, hidden: false },
        { group: 0, hidden: false },
      ]),
    ).toBe(1);
    // With only an empty row visible there is nothing useful to hide, so nothing is added.
    expect(
      complementarySuppression([
        { group: 4, hidden: true },
        { group: 0, hidden: false },
      ]),
    ).toBeNull();
  });

  it('leaves time-only results alone', () => {
    const shaped = suppressRows([row('T1', 3, 3)], compiled({ hasNonTimeDimension: false }));
    expect(shaped.rows).toEqual([['T1', 3]]);
    expect(shaped.suppressed).toBe(0);
    expect(shaped.complementary).toBe(false);
  });
});
