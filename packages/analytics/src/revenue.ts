// The one rule for a result's published currency (#958, #1050). Both `analytics.campaignSummary`
// and `analytics.query` expose a single `meta.currency`, and a client keying suppression detection
// on `meta.currency === null` must not see a currency whose amount was withheld. Keeping the rule
// in one place is what stops the two surfaces from drifting apart again.

/** One currency row: its amount is null when the k floor withheld it. */
export interface RevenueRow {
  currency: string;
  amount: number | null;
}

/**
 * The headline revenue rows: a currency the query suppressed keeps its row with a null amount, so
 * the reader knows the currency exists and the UI can still see that there is more than one. Only
 * a non-string currency or a value that is neither a number nor null is dropped.
 */
export function summaryRevenue(rows: readonly (readonly unknown[])[], currencyIndex: number, revenueIndex: number): RevenueRow[] {
  return rows.flatMap((row) => {
    const currency = row[currencyIndex];
    const amount = row[revenueIndex];
    return typeof currency === 'string' && (typeof amount === 'number' || amount === null) ? [{ currency, amount }] : [];
  });
}

/**
 * The currency `meta.currency` may name (#958, #1050): every revenue row has a visible amount and
 * they all share one known currency (not `UNKNOWN`). A suppressed amount is withheld, so publishing
 * its currency would tell a client the campaign is measurable in it, and `UNKNOWN` is not a
 * currency at all. A single-row result (the campaign summary) follows the same rule: exactly one
 * visible currency that is not `UNKNOWN`. Currency cells are normalised to upper case so both
 * surfaces answer `EUR` for an `eur` cell and reject any case of `unknown`, as the query layer did
 * before the rule was shared.
 */
export function summaryCurrency(revenue: readonly RevenueRow[]): string | null {
  if (!revenue.length || revenue.some((row) => row.amount === null)) return null;
  const currencies = new Set(revenue.map((row) => row.currency.toUpperCase()));
  if (currencies.size !== 1) return null;
  const currency = [...currencies][0]!;
  return currency === 'UNKNOWN' ? null : currency;
}
