import { complementarySuppression, complementaryTotal } from '@agentic-marketing/artifacts';
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

// Campaign rows carry two group sizes: the campaign's recipients (the row's k) and the converters
// in its currency (the revenue k). Currency partitions revenue, never people, so the campaign is
// the contributor for the people total and the (campaign, currency) pair for a revenue total.
const campaignCompiled = () => ({
  outputs: [
    { kind: 'dimension' as const, dimension: 'campaign' as const, alias: 'dim_campaign' },
    { kind: 'dimension' as const, dimension: 'currency' as const, alias: 'dim_currency' },
    { kind: 'measure' as const, measure: MEASURES['campaign.recipients']!, alias: 'm_recipients' },
    { kind: 'measure' as const, measure: MEASURES['campaign.revenue']!, alias: 'm_revenue' },
  ],
  kAlias: 'k_group',
  revenueKAlias: 'k_revenue_group',
  hasNonTimeDimension: true,
});

const campaignRow = (campaign: string, currency: string, recipients: number, revenue: number, converters: number) => ({
  dim_campaign: campaign,
  dim_currency: currency,
  m_recipients: recipients,
  m_revenue: revenue,
  k_group: recipients,
  k_revenue_group: converters,
});

const moneyColumn = (rows: (string | number | null)[][]) => rows.reduce((sum, r) => sum + (typeof r[3] === 'number' ? r[3] : 0), 0);

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
    expect(shaped.withheld).toEqual([]);
  });
});

// The reviewer's four probes for #692: a flat row list protects nothing when the total is
// per currency, when revenue's own k hides a cell, when one campaign spans several currency rows,
// or when the only visible contributor is an empty row. Each fixture asserts that total minus
// visible rows is not the hidden value (or that the total is withheld).
describe('complementary suppression per total (#692 round 2)', () => {
  it('groups currency rows by campaign, so a hidden USD campaign is not revealed by the USD total', () => {
    // A (3 recipients, USD 30) is hidden; B (5, EUR 50) is the old complement. The visible USD
    // total of 130 minus C (100) would then be A's 30. Per currency, USD has one hidden
    // contributor (A) and one visible non-zero (C), so C's revenue is hidden too, and EUR has
    // only the hidden B, so its total is withheld.
    const shaped = suppressRows(
      [campaignRow('A', 'USD', 3, 30, 3), campaignRow('B', 'EUR', 5, 50, 5), campaignRow('C', 'USD', 10, 100, 10)],
      campaignCompiled(),
    );

    expect(shaped.rows).toEqual([
      ['A', 'USD', null, null],
      ['B', 'EUR', null, null],
      ['C', 'USD', 10, null],
    ]);
    expect(shaped.suppressed).toBe(3);
    expect(shaped.complementary).toBe(true);
    expect(shaped.withheld).toContain('campaign.revenue:EUR');
    // The USD total is 130 and nothing visible is left in it: 130 is the sum of A and C, not A.
    expect(moneyColumn(shaped.rows)).toBe(0);
    expect(130 - moneyColumn(shaped.rows)).not.toBe(30);
  });

  it('protects revenue when its own converter floor hid the cell', () => {
    // Both campaigns reached six people, so neither row is below k. A has three USD converters,
    // below k, so only its revenue is null. The USD total of 130 minus the visible B (100) would
    // be A's 30, so B's revenue is hidden too even though B's row stays readable.
    const shaped = suppressRows([campaignRow('A', 'USD', 6, 30, 3), campaignRow('B', 'USD', 6, 100, 6)], campaignCompiled());

    expect(shaped.rows).toEqual([
      ['A', 'USD', 6, null],
      ['B', 'USD', 6, null],
    ]);
    expect(shaped.suppressed).toBe(2);
    // One row is a revenue-floor hide; the other is its complement, which is counted in
    // suppressed but not in the "fewer than k converters" note.
    expect(shaped.revenueSuppressed).toBe(1);
    expect(shaped.complementary).toBe(true);
    expect(130 - moneyColumn(shaped.rows)).not.toBe(30);
  });

  it('counts one campaign spread over several currency rows as one contributor', () => {
    // A converts in USD and EUR; both physical rows are below k. Treating them as two hidden rows
    // hid nothing else, so the campaign-wide total of 13 gave A's 3. Grouped by campaign, A is one
    // hidden contributor and B (10) is the visible complement.
    const shaped = suppressRows(
      [campaignRow('A', 'USD', 3, 30, 3), campaignRow('A', 'EUR', 3, 20, 3), campaignRow('B', 'USD', 10, 100, 10)],
      campaignCompiled(),
    );

    expect(shaped.rows).toEqual([
      ['A', 'USD', null, null],
      ['A', 'EUR', null, null],
      ['B', 'USD', null, null],
    ]);
    expect(shaped.suppressed).toBe(3);
    expect(shaped.complementary).toBe(true);
    // 13 − 0 is the sum of A and B, not A's 3.
    expect(13 - visibleSum(shaped.rows)).not.toBe(3);
    expect(shaped.withheld).toContain('campaign.revenue:EUR');
  });

  it('withholds a total when no visible contributor with a value is left', () => {
    // One group reaches four people and no other group is visible. There is no row to hide in its
    // place, so the people total (and the measure total beside it) is withheld instead: the
    // narrow option-A fallback. campaignSummary covers the same case with a visible zero member.
    const shaped = suppressRows([row('A', 4, 4)], compiled());

    expect(shaped.rows).toEqual([['A', null]]);
    expect(shaped.suppressed).toBe(1);
    expect(shaped.complementary).toBe(false);
    expect(shaped.withheld).toContain('group size');
    expect(shaped.withheld).toContain('email.sent');

    expect(
      complementaryTotal([
        { id: 0, group: 4, value: 4, hidden: true },
        { id: 1, group: 0, value: 0, hidden: false },
      ]),
    ).toEqual({ hide: [], withheld: true });
    // A visible non-zero contributor can still be hidden.
    expect(
      complementaryTotal([
        { id: 0, group: 4, value: 4, hidden: true },
        { id: 1, group: 6, value: 6, hidden: false },
        { id: 2, group: 0, value: 0, hidden: false },
      ]),
    ).toEqual({ hide: [1], withheld: false });
  });

  it('repeats until stable, so hiding a complement in one total protects another', () => {
    // Pass one: the people total has one hidden contributor (A, 3) and hides the smallest visible
    // row (B, 5). A has no USD row, so before that hide the USD revenue total had no hidden
    // contributor. Hiding B's whole row also hides its revenue, leaving USD with exactly one
    // hidden contributor (B, 50); pass two hides the smallest visible USD revenue (C, 100). A
    // single pass would leave C visible and 150 − 100 = 50 would be B's revenue.
    const shaped = suppressRows(
      [campaignRow('A', 'EUR', 3, 20, 3), campaignRow('B', 'USD', 5, 50, 5), campaignRow('C', 'USD', 10, 100, 10)],
      campaignCompiled(),
    );

    expect(shaped.rows).toEqual([
      ['A', 'EUR', null, null],
      ['B', 'USD', null, null],
      ['C', 'USD', 10, null],
    ]);
    expect(shaped.suppressed).toBe(3);
    expect(shaped.complementary).toBe(true);
    expect(150 - moneyColumn(shaped.rows)).not.toBe(50);
    expect(150 - moneyColumn(shaped.rows)).not.toBe(100);
  });
});
