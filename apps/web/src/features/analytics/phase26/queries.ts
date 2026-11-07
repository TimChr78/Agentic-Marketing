import type { AnalyticsRange } from './period';

export interface QueryFilters {
  broadcast?: string;
}

export interface QueryPlanInput {
  measures: string[];
  range: Pick<AnalyticsRange, 'from' | 'to'>;
  kind: 'totals' | 'series';
  filters?: QueryFilters;
  /** The conversion source groups revenue by its own currency, so its totals read keeps every row. */
  conversion?: boolean;
}

/**
 * The contract's exact reads: totals use dimensions:[] and limit 1 (except conversion value, where
 * currency is implicit and limit 1 could discard currencies); series use day, ascending, 5000 rows.
 */
export function queryInput({ measures, range, kind, filters, conversion }: QueryPlanInput) {
  const broadcast = filters?.broadcast;
  return {
    measures: [...measures],
    dimensions: kind === 'series' ? ['day'] : [],
    from: range.from,
    to: range.to,
    limit: kind === 'totals' ? (conversion ? 5000 : 1) : 5000,
    ...(kind === 'series' ? { order: { by: 'day', dir: 'asc' as const } } : {}),
    ...(broadcast ? { filters: { broadcast: [broadcast] } } : {}),
  };
}
