import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnalyticsPage from '../../../pages/insights/AnalyticsPage';
import { setWorkspaceTimeZone } from '../../../ui/time';
import { countComparison, countDelta, formatPercent, REVENUE_UNAVAILABLE, rateComparison, rateDelta, revenueGate } from './model';

// #506 acceptance: the exact reads per preset and period, comparison maths, the currency gate and
// every data state. The API is a request spy, so the assertions are about commands, not rows.

configure({ asyncUtilTimeout: 5000 });

// ECharts' lazy module reads the colour-scheme media query at import time; jsdom has no matchMedia.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: any }[],
  can: true,
  suppressed: 0,
  currencyMode: 'single' as 'single' | 'mixed' | 'missing' | 'different',
  fail: null as null | ((name: string, input: any) => string | null),
  empty: false,
  zero: false,
  nulls: false,
  priorZero: false,
  deferred: null as null | { promise: Promise<unknown>; resolve: (value: unknown) => void; used?: boolean },
  slow: null as null | ((input: any) => Promise<unknown> | null),
}));

const UNITS: Record<string, 'count' | 'ratio' | 'currency'> = {
  'email.sent': 'count',
  'email.delivered': 'count',
  'email.bounced': 'count',
  'email.complained': 'count',
  'email.opened': 'count',
  'email.clicked': 'count',
  'email.unsubscribed': 'count',
  'email.open_rate': 'ratio',
  'email.click_rate': 'ratio',
  'email.unsubscribe_rate': 'ratio',
  'email.bounce_rate': 'ratio',
  'email.complaint_rate': 'ratio',
  'journey.entered': 'count',
  'journey.goal_reached': 'count',
  'journey.completed': 'count',
  'journey.exited': 'count',
  'journey.failed': 'count',
  'journey.step_reached': 'count',
  conversions: 'count',
  revenue: 'currency',
};

const SOURCES: Record<string, string> = {
  'email.sent': 'message_events',
  'email.delivered': 'message_events',
  'email.bounced': 'message_events',
  'email.complained': 'message_events',
  'email.opened': 'message_events',
  'email.clicked': 'message_events',
  'email.unsubscribed': 'message_events',
  'email.open_rate': 'message_events',
  'email.click_rate': 'message_events',
  'email.unsubscribe_rate': 'message_events',
  'email.bounce_rate': 'message_events',
  'email.complaint_rate': 'message_events',
  'journey.entered': 'journey_events',
  'journey.goal_reached': 'journey_events',
  'journey.completed': 'journey_events',
  'journey.exited': 'journey_events',
  'journey.failed': 'journey_events',
  'journey.step_reached': 'journey_events',
  conversions: 'events',
  revenue: 'events',
};

const RATIO_BASES: Record<string, [string, string]> = {
  'email.open_rate': ['email.opened', 'email.delivered'],
  'email.click_rate': ['email.clicked', 'email.delivered'],
  'email.unsubscribe_rate': ['email.unsubscribed', 'email.delivered'],
  'email.bounce_rate': ['email.bounced', 'email.sent'],
  'email.complaint_rate': ['email.complained', 'email.sent'],
};

const catalogue = {
  measures: Object.keys(UNITS).map((id) => ({
    id,
    description: id,
    unit: UNITS[id],
    aggregation: UNITS[id] === 'ratio' ? 'ratio' : UNITS[id] === 'currency' ? 'sum' : 'distinct profiles',
    source: SOURCES[id],
    dimensions: ['day', 'week', 'month'],
    defaultGrain: 'day',
    kind: RATIO_BASES[id] ? 'ratio' : 'base',
    ...(RATIO_BASES[id] ? { numerator: RATIO_BASES[id][0], denominator: RATIO_BASES[id][1] } : {}),
  })),
  dimensions: [{ id: 'day', description: 'Day', time: true, sources: ['message_events', 'journey_events', 'events'] }],
};

const CURRENT_FROM = '2026-10-31T00:00:00.000Z';
const CURRENT_TO = '2026-11-06T23:59:59.999Z';
const PRIOR_FROM = '2026-10-24T00:00:00.000Z';
const PRIOR_TO = '2026-10-30T23:59:59.999Z';
const FRESHNESS = '2026-11-06T21:42:00.000Z';

const currentValues: Record<string, number> = {
  'email.sent': 2600,
  'email.delivered': 2400,
  'email.bounced': 48,
  'email.complained': 2,
  'email.opened': 1008,
  'email.clicked': 192,
  'email.unsubscribed': 12,
  'email.open_rate': 0.42,
  'email.click_rate': 0.08,
  'email.unsubscribe_rate': 0.005,
  'email.bounce_rate': 48 / 2600,
  'email.complaint_rate': 2 / 2600,
  'journey.entered': 800,
  'journey.goal_reached': 120,
  'journey.completed': 90,
  'journey.exited': 40,
  'journey.failed': 3,
  'journey.step_reached': 200,
  conversions: 60,
  revenue: 9000,
};

const priorValues: Record<string, number> = {
  ...currentValues,
  'email.delivered': 2160,
  'email.clicked': 168,
  'email.unsubscribed': 14,
  'email.open_rate': 0.4,
  'email.click_rate': 0.0777,
  'email.unsubscribe_rate': 0.0065,
  'email.opened': 900,
  'email.sent': 2400,
  'email.bounced': 60,
  'email.complained': 3,
  'journey.entered': 700,
  'journey.goal_reached': 100,
  'journey.completed': 80,
  'journey.exited': 30,
  'journey.failed': 4,
  'journey.step_reached': 180,
  conversions: 50,
  revenue: 8000,
};

const daySeries = (from: string, values: Record<string, number>) => {
  const start = new Date(from);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return day;
  }).map((day) => ({ day, scale: 0.8 + (Number(day.slice(-1)) % 5) / 10, values }));
};

const columnsFor = (measures: string[], dimensions: string[]) => [
  ...dimensions.map((name) => ({ name, kind: 'dimension' as const })),
  ...(measures.includes('revenue') ? [{ name: 'currency', kind: 'dimension' as const }] : []),
  ...measures.map((id) => ({ name: id, kind: 'measure' as const, unit: UNITS[id] })),
];

const resultFor = (input: any) => {
  const period = input.from <= PRIOR_TO ? 'prior' : 'current';
  const values = period === 'prior' ? priorValues : currentValues;
  const dimensions: string[] = input.dimensions ?? [];
  const measures: string[] = input.measures;
  const from = input.from;
  const series = dimensions.includes('day');

  if (h.nulls) {
    const columns = columnsFor(measures, dimensions);
    const rows = series ? daySeries(from, values).map((entry) => [entry.day, ...measures.map(() => null)]) : [measures.map(() => null)];
    return {
      columns,
      rows,
      meta: { timeZone: 'UTC', currency: null, from, to: input.to, freshness: null, suppressed: h.suppressed, k: 5, notes: [] },
    };
  }

  if (h.empty) {
    return {
      columns: columnsFor(measures, dimensions),
      rows: [],
      meta: { timeZone: 'UTC', currency: null, from, to: input.to, freshness: null, suppressed: 0, k: 5, notes: [] },
    };
  }

  const zeroValue = (id: string) => (UNITS[id] === 'ratio' ? null : 0);

  if (measures.includes('revenue')) {
    const currentCurrency = h.currencyMode === 'different' ? (period === 'current' ? 'USD' : 'EUR') : 'USD';
    const currencies = h.currencyMode === 'mixed' ? ['EUR', 'USD'] : h.currencyMode === 'missing' ? ['UNKNOWN'] : [currentCurrency];
    const currencyValue = (id: string, currencyIndex: number) => {
      if (id === 'conversions') return 40 - currencyIndex * 10;
      if (id === 'revenue') return 9000 / (currencyIndex + 1);
      return h.zero ? zeroValue(id) : (values[id] ?? 0);
    };
    if (series) {
      const rows = daySeries(from, values).flatMap((entry) =>
        currencies.map((currency) => [entry.day, currency, ...measures.map((id) => currencyValue(id, currencies.indexOf(currency)))]),
      );
      return {
        columns: columnsFor(measures, dimensions),
        rows,
        meta: {
          timeZone: 'UTC',
          currency: h.currencyMode === 'single' || h.currencyMode === 'different' ? currentCurrency : null,
          from,
          to: input.to,
          freshness: period === 'current' ? FRESHNESS : null,
          suppressed: h.suppressed,
          k: 5,
          notes: [],
        },
      };
    }
    const rows = currencies.map((currency) => [currency, ...measures.map((id) => currencyValue(id, currencies.indexOf(currency)))]);
    return {
      columns: columnsFor(measures, dimensions),
      rows,
      meta: {
        timeZone: 'UTC',
        currency: h.currencyMode === 'single' || h.currencyMode === 'different' ? currentCurrency : null,
        from,
        to: input.to,
        freshness: period === 'current' ? FRESHNESS : null,
        suppressed: h.suppressed,
        k: 5,
        notes: [],
      },
    };
  }

  if (series) {
    const rows = daySeries(from, values).map((entry) => [
      entry.day,
      ...measures.map((id) =>
        h.zero
          ? zeroValue(id)
          : Math.round((values[id] ?? 0) * entry.scale * (UNITS[id] === 'ratio' ? 10000 : 1)) / (UNITS[id] === 'ratio' ? 10000 : 1),
      ),
    ]);
    return {
      columns: columnsFor(measures, dimensions),
      rows,
      meta: {
        timeZone: 'UTC',
        currency: null,
        from,
        to: input.to,
        freshness: period === 'current' ? FRESHNESS : FRESHNESS,
        suppressed: h.suppressed,
        k: 5,
        notes: [],
      },
    };
  }

  const row = measures.map((id) => (h.zero || (h.priorZero && period === 'prior') ? zeroValue(id) : (values[id] ?? 0)));
  return {
    columns: columnsFor(measures, dimensions),
    rows: [row],
    meta: {
      timeZone: 'UTC',
      currency: null,
      from,
      to: input.to,
      freshness: period === 'current' ? FRESHNESS : null,
      suppressed: h.suppressed,
      k: 5,
      notes: [],
    },
  };
};

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: any) => {
        h.calls.push({ name, input });
        const slow = h.slow?.(input);
        if (slow) return slow;
        if (
          h.deferred &&
          !h.deferred.used &&
          name === 'analytics.query' &&
          input.dimensions?.includes('day') &&
          input.from === CURRENT_FROM
        ) {
          h.deferred.used = true;
          return h.deferred.promise;
        }
        const failure = h.fail?.(name, input);
        if (failure) throw new Error(failure);
        if (name === 'analytics.metrics.list') return catalogue;
        if (name === 'analytics.query') return resultFor(input);
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

// ECharts cannot draw in jsdom and is slow to initialise; the charts' table fallbacks carry the
// values these tests assert on.
vi.mock('../../../components/Chart', () => ({ Chart: () => null }));

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => h.can, workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
  useWorkspace: () => ({ can: () => h.can, workspace: { id: 'ws_1' }, user: { id: 'u1' } }),
}));

const queryCalls = () => h.calls.filter((call) => call.name === 'analytics.query');
const catalogueCalls = () => h.calls.filter((call) => call.name === 'analytics.metrics.list');

const renderAt = (query = 'from=2026-10-31&to=2026-11-06') => {
  history.replaceState(null, '', `/insights/analytics?${query}`);
  return render(<AnalyticsPage />);
};

const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

const waitForReads = async (count = 4) => {
  await waitFor(() => expect(queryCalls()).toHaveLength(count));
};

beforeEach(() => {
  setWorkspaceTimeZone('UTC');
  cleanup();
  h.calls.length = 0;
  h.can = true;
  h.suppressed = 0;
  h.currencyMode = 'single';
  h.fail = null;
  h.empty = false;
  h.zero = false;
  h.nulls = false;
  h.priorZero = false;
  h.deferred = null;
  h.slow = null;
});

afterEach(cleanup);

describe('fixed presets and exact reads (#506)', () => {
  it('loads the catalogue once and issues exactly two reads per period for the newsletter preset', async () => {
    renderAt();
    await waitForReads(4);

    expect(catalogueCalls()).toHaveLength(1);
    const reads = queryCalls();
    const totals = reads.filter((call) => call.input.dimensions.length === 0);
    const series = reads.filter((call) => call.input.dimensions[0] === 'day');
    expect(totals).toHaveLength(2);
    expect(series).toHaveLength(2);

    const newsletter = [
      'email.sent',
      'email.delivered',
      'email.opened',
      'email.clicked',
      'email.unsubscribed',
      'email.open_rate',
      'email.click_rate',
      'email.unsubscribe_rate',
    ];
    for (const call of reads.filter((entry) => entry.input.from === CURRENT_FROM)) {
      expect(call.input.measures).toEqual(newsletter);
      expect(call.input.to).toBe(CURRENT_TO);
    }
    for (const call of reads.filter((entry) => entry.input.from === PRIOR_FROM)) {
      expect(call.input.measures).toEqual(newsletter);
      expect(call.input.to).toBe(PRIOR_TO);
    }
    const currentTotals = reads[0].input;
    expect(screen.queryByText('email.delivered')).toBeNull();
    expect(screen.queryByText('journey.entered')).toBeNull();
    expect(currentTotals.limit).toBe(1);
    expect(currentTotals.dimensions).toEqual([]);
    const currentSeries = reads[3].input;
    expect(currentSeries.limit).toBe(5000);
    expect(currentSeries.dimensions).toEqual(['day']);
    expect(currentSeries.order).toEqual({ by: 'day', dir: 'asc' });
  });

  it('uses the five journey measures for the Journey conversion preset', async () => {
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;

    choose('Question', 'journey');
    await waitForReads(4);

    const expected = ['journey.entered', 'journey.goal_reached', 'journey.completed', 'journey.exited', 'journey.failed'];
    for (const call of queryCalls()) expect(call.input.measures).toEqual(expected);
    expect(queryCalls()[0].input.filters).toBeUndefined();
  });

  it('uses the five deliverability measures for the Deliverability preset', async () => {
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;

    choose('Question', 'deliverability');
    await waitForReads(4);

    const expected = ['email.sent', 'email.bounced', 'email.complained', 'email.bounce_rate', 'email.complaint_rate'];
    for (const call of queryCalls()) expect(call.input.measures).toEqual(expected);
  });

  it('keeps the conversion plan at four reads and raises the totals limit so currencies are not discarded', async () => {
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;

    fireEvent.click(screen.getByText('Conversions'));
    await waitForReads(4);

    expect(catalogueCalls()).toHaveLength(0);
    for (const call of queryCalls()) expect(call.input.measures).toEqual(['conversions', 'revenue']);
    const totals = queryCalls().filter((call) => call.input.dimensions.length === 0);
    expect(totals.every((call) => call.input.limit === 5000)).toBe(true);
  });

  it('starts a deep-linked conversion selection with exactly five calls including the catalogue', async () => {
    renderAt('from=2026-10-31&to=2026-11-06&measures=conversions,revenue');
    await waitForReads(4);

    expect(catalogueCalls()).toHaveLength(1);
    for (const call of queryCalls()) expect(call.input.measures).toEqual(['conversions', 'revenue']);
    expect((screen.getByLabelText('Question') as HTMLSelectElement).value).toBe('conversion');
  });

  it('refresh reruns four reads and never the catalogue', async () => {
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitForReads(4);
    expect(catalogueCalls()).toHaveLength(0);
  });

  it('comparison off issues two reads for a selection change instead of four', async () => {
    renderAt();
    await waitForReads(4);
    fireEvent.click(screen.getByText('Compare previous period'));
    h.calls.length = 0;

    choose('Question', 'journey');
    await waitForReads(2);
    expect(catalogueCalls()).toHaveLength(0);
    for (const call of queryCalls()) expect(call.input.measures[0]).toBe('journey.entered');
  });

  it('retains a valid broadcast filter on email reads and drops it when the source changes', async () => {
    const broadcast = `bct_${'a'.repeat(32)}`;
    renderAt(`from=2026-10-31&to=2026-11-06&broadcast=${broadcast}`);
    await waitForReads(4);
    for (const call of queryCalls()) expect(call.input.filters).toEqual({ broadcast: [broadcast] });
    expect(screen.getByText('Broadcast filter')).toBeTruthy();

    h.calls.length = 0;
    choose('Question', 'journey');
    await waitForReads(4);
    for (const call of queryCalls()) expect(call.input.filters).toBeUndefined();
    expect(screen.queryByText('Broadcast filter')).toBeNull();
  });

  it('a ratio always brings its numerator and denominator back', async () => {
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;

    fireEvent.click(screen.getByText('Clicked'));
    await waitForReads(4);
    let measures = queryCalls().at(-1)!.input.measures;
    expect(measures).not.toContain('email.clicked');
    expect(measures).not.toContain('email.click_rate');

    h.calls.length = 0;
    fireEvent.click(screen.getByText('Click rate'));
    await waitForReads(4);
    measures = queryCalls().at(-1)!.input.measures;
    expect(measures).toContain('email.click_rate');
    expect(measures).toContain('email.clicked');
    expect(measures).toContain('email.delivered');
  });

  it('issues no per-row reads and no reads when the role is restricted', async () => {
    renderAt();
    await waitForReads(4);
    expect(queryCalls()).toHaveLength(4);

    cleanup();
    h.calls.length = 0;
    h.can = false;
    renderAt();
    expect(screen.getByText(/No protected reads were made/)).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it('defaults to the last seven complete days and offers the thirty-day period', async () => {
    renderAt('');
    await waitForReads(4);
    expect((screen.getByLabelText('Period') as HTMLSelectElement).value).toBe('7');
    const first = queryCalls()[0].input;
    expect(first.from).toMatch(/T00:00:00\.000Z$/);
    expect(first.to).toMatch(/T23:59:59\.999Z$/);
  });
});

describe('comparison maths (#506)', () => {
  it('compares counts relatively and rates in percentage points', () => {
    expect(countDelta(2400, 2160)).toMatchObject({ text: '+11.1%', direction: 'up' });
    expect(countComparison(2400, 2160, (value) => value.toLocaleString()).text).toBe('Prior 2,160 · +11.1%');
    expect(rateDelta(0.08, 0.068)).toMatchObject({ text: '+1.2 pp', direction: 'up' });
    expect(rateComparison(0.08, 0.068, formatPercent).text).toBe('Prior 6.8% · +1.2 pp');
  });

  it('has no relative delta against a zero prior, and no delta when either side is unavailable', () => {
    expect(countDelta(12, 0)).toMatchObject({ text: 'No comparable baseline', direction: 'none' });
    expect(countComparison(12, 0, (value) => value.toLocaleString()).text).toBe('Prior 0 · No comparable baseline');
    expect(countDelta(12, null).direction).toBe('none');
    expect(rateDelta(null, 0.1).direction).toBe('none');
  });

  it('shows the previous value and zero-prior notice in the built screen', async () => {
    renderAt();
    await waitForReads(4);
    expect(screen.getAllByText(/Prior 2,160 · \+11\.1%/).length).toBeGreaterThan(0);
  });

  it('shows absolute counts and no relative delta when the previous period is zero', async () => {
    h.priorZero = true;
    renderAt();
    await waitForReads(4);
    expect(screen.getByText('Previous period returned 0')).toBeTruthy();
    expect(screen.getAllByText(/Prior 0 · No comparable baseline/).length).toBeGreaterThan(0);
  });

  it('puts the chart before the table and keeps both actual dates in each row', async () => {
    renderAt();
    await waitForReads(4);
    const chart = screen.getByRole('heading', { name: 'Delivered over time' });
    const table = screen.getByRole('heading', { name: 'Result table' });
    expect(chart.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('31 Oct / 24 Oct')).toBeTruthy();
  });
});

describe('currency gate (#506)', () => {
  it('allows a chart only for one usable currency, and the same currency in the comparison', () => {
    const meta = (currency: string | null) => ({
      timeZone: 'UTC',
      currency,
      from: CURRENT_FROM,
      to: CURRENT_TO,
      freshness: null,
      suppressed: 0,
      k: 5,
      notes: [],
    });
    expect(revenueGate({ currentMeta: meta('USD'), currentCurrencies: ['USD'], comparing: false })).toEqual({ ok: true, currency: 'USD' });
    expect(revenueGate({ currentMeta: meta(null), currentCurrencies: ['EUR', 'USD'], comparing: false })).toMatchObject({
      ok: false,
      reason: 'mixed',
    });
    expect(revenueGate({ currentMeta: meta(null), currentCurrencies: ['UNKNOWN'], comparing: false })).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(
      revenueGate({
        currentMeta: meta('USD'),
        currentCurrencies: ['USD'],
        priorMeta: meta('EUR'),
        priorCurrencies: ['EUR'],
        comparing: true,
      }),
    ).toMatchObject({ ok: false, reason: 'different' });
  });

  it('replaces the revenue chart for mixed currencies and keeps each labelled table row', async () => {
    h.currencyMode = 'mixed';
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;
    fireEvent.click(screen.getByText('Conversions'));
    await waitForReads(4);

    expect(screen.getByText(REVENUE_UNAVAILABLE)).toBeTruthy();
    expect(screen.getAllByText('EUR').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USD').length).toBeGreaterThan(0);
  });

  it('replaces the revenue chart when no currency is available and never invents a default', async () => {
    h.currencyMode = 'missing';
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;
    fireEvent.click(screen.getByText('Conversions'));
    await waitForReads(4);

    expect(screen.getByText(REVENUE_UNAVAILABLE)).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('does not compare different currencies across periods', async () => {
    h.currencyMode = 'different';
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;
    fireEvent.click(screen.getByText('Conversions'));
    await waitForReads(4);
    expect(screen.getByText(REVENUE_UNAVAILABLE)).toBeTruthy();
  });

  it('charts revenue for a single currency in both periods', async () => {
    renderAt();
    await waitForReads(4);
    h.calls.length = 0;
    fireEvent.click(screen.getByText('Conversions'));
    await waitForReads(4);
    expect(screen.queryByText(REVENUE_UNAVAILABLE)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Revenue over time' })).toBeTruthy();
  });
});

describe('data states (#506)', () => {
  it('keeps controls and shows a section skeleton while loading', async () => {
    let resolve!: (value: unknown) => void;
    h.deferred = { promise: new Promise((done) => (resolve = done)), resolve: (value) => resolve(value) };
    renderAt();
    expect(await screen.findByLabelText('Loading analytics')).toBeTruthy();
    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(screen.getByLabelText('Question')).toBeTruthy();
    resolve(resultFor({ from: CURRENT_FROM, to: CURRENT_TO, dimensions: ['day'], measures: ['email.delivered'] }));
  });

  it('explains an empty period and keeps the period control', async () => {
    h.empty = true;
    renderAt();
    await waitFor(() => expect(screen.getByText('No recorded activity in this period')).toBeTruthy());
    expect(screen.getByLabelText('Period')).toBeTruthy();
  });

  it('renders an explicit zero as zero and never as healthy', async () => {
    h.zero = true;
    renderAt();
    await waitForReads(4);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getByText('Zero recorded events')).toBeTruthy();
  });

  it('shows em dashes and Unavailable for null values', async () => {
    h.nulls = true;
    renderAt();
    await waitForReads(4);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
  });

  it('shows the server k and notes for suppressed values without inferring them', async () => {
    h.nulls = true;
    h.suppressed = 3;
    renderAt();
    await waitForReads(4);
    expect(screen.getByText('Values unavailable — fewer than 5 people')).toBeTruthy();
    expect(screen.getAllByText(/k=5/).length).toBeGreaterThan(0);
  });

  it('keeps successful sections when one read fails and retries just that section', async () => {
    h.fail = (name, input) =>
      name === 'analytics.query' && input.from === PRIOR_FROM && input.dimensions?.includes('day') ? 'temporary failure' : null;
    renderAt();
    await waitFor(() => expect(screen.getByText('One section could not load')).toBeTruthy());
    expect(screen.getByText('Delivered people')).toBeTruthy();

    h.fail = null;
    h.calls.length = 0;
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    await waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
  });

  it('shows no old values as current when every read fails, and retries', async () => {
    h.fail = () => 'server unavailable';
    renderAt();
    await waitFor(() => expect(screen.getByText('Could not load analytics')).toBeTruthy());
    expect(screen.queryByText('Delivered people')).toBeNull();

    h.fail = null;
    h.calls.length = 0;
    const alert = screen.getByText('Could not load analytics').closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitForReads(4);
  });

  it('shows no old values under a new selection while its reads are pending', async () => {
    renderAt();
    await waitForReads(4);
    expect(screen.getByText('Delivered people')).toBeTruthy();

    h.slow = (input) => (input.measures?.includes('journey.entered') ? new Promise(() => {}) : null);
    choose('Question', 'journey');
    await waitForReads(8);

    expect(screen.getByLabelText('Loading analytics')).toBeTruthy();
    expect(screen.queryByText('Delivered people')).toBeNull();
    expect(screen.queryByText('Delivered over time')).toBeNull();
    expect(screen.queryByText('Result table')).toBeNull();
  });

  it('never pairs a newly returned totals result with a series from another selection', async () => {
    renderAt();
    await waitForReads(4);

    // The new totals land, but the new series is still pending: the old series must not be shown
    // beside the new totals under the new question.
    h.slow = (input) => (input.measures?.includes('journey.entered') && input.dimensions?.includes('day') ? new Promise(() => {}) : null);
    choose('Question', 'journey');
    await waitForReads(8);

    expect(screen.getByLabelText('Loading analytics')).toBeTruthy();
    // 800 is the new totals result; it must wait for the matching series rather than join old rows.
    expect(screen.queryByText('800')).toBeNull();
    expect(screen.queryByText('Delivered over time')).toBeNull();
    expect(screen.queryByText('Result table')).toBeNull();
  });

  it('never lets a stale response replace a newer selection', async () => {
    let resolve!: (value: unknown) => void;
    h.deferred = { promise: new Promise((done) => (resolve = done)), resolve: (value) => resolve(value) };
    renderAt();
    await waitForReads(4);

    choose('Question', 'journey');
    await waitForReads(8);
    resolve(resultFor({ from: CURRENT_FROM, to: CURRENT_TO, dimensions: ['day'], measures: ['email.delivered'] }));
    await waitFor(() => expect(screen.getAllByText('Entered').length).toBeGreaterThan(0));
    expect(screen.queryByText('Delivered people')).toBeNull();
  });

  it('distinguishes not found from empty', async () => {
    h.fail = () => 'Not found';
    renderAt();
    await waitFor(() => expect(screen.getByText('This item is not available at this address')).toBeTruthy());
  });
});
