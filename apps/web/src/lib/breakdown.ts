// Whether an analytics result has a breakdown beside its time grain (#442 review): then several
// rows share one date, and a single line through them would join different groups.

export const TIME_DIMENSIONS = new Set(['day', 'week', 'month']);

/** Every returned dimension counts, including the `currency` the compiler adds to revenue queries. */
export function hasBreakdown(columns: { name: string; kind?: string }[]): boolean {
  return columns.some((c) => c.kind !== 'measure' && !TIME_DIMENSIONS.has(c.name));
}
