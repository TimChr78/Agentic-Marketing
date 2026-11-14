/**
 * Spend import completeness (#917 review round 2).
 *
 * A truncated provider read stores the date range it could not complete, so a later complete refresh
 * of a few days cannot turn the warning off for the older days. The state is a small list of closed
 * date ranges per connection (platform and account are the connection's own), kept in
 * `connections.spend_state` and only ever written by the import.
 *
 * The provider APIs do not promise that pages arrive in date order, so a truncated read cannot know
 * which days it did complete: the whole requested window is recorded as incomplete. A complete read
 * removes exactly the days it covers (splitting a stored range when it covers the middle).
 */

/** A closed range of calendar days, both ends included, formatted YYYY-MM-DD. */
export interface DateInterval {
  from: string;
  to: string;
}

/** Server-owned state of one connection's spend imports. */
export interface SpendState {
  incomplete?: DateInterval[];
}

/** Keep the list small; a cap hit merges everything into one covering range, never drops a day. */
export const SPEND_STATE_MAX_INTERVALS = 8;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const startOf = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && Number.isFinite(startOf(value));

/** A usable interval, or null when a bound is not a day or the range is reversed. */
function usable(interval: Partial<DateInterval> | undefined): DateInterval | null {
  if (!interval || !isDay(interval.from) || !isDay(interval.to)) return null;
  if (startOf(interval.from) > startOf(interval.to)) return null;
  return { from: interval.from, to: interval.to };
}

/**
 * Read stored state without trusting its shape: only well-formed ranges survive, so a hand-edited or
 * older value can never widen a report's warning or crash a read.
 */
export function parseSpendState(value: unknown): SpendState {
  const raw = value && typeof value === 'object' ? (value as { incomplete?: unknown }).incomplete : undefined;
  const intervals = Array.isArray(raw) ? raw.flatMap((entry) => usable(entry as Partial<DateInterval>) ?? []) : [];
  return intervals.length ? { incomplete: normalizeIntervals(intervals) } : {};
}

/**
 * Sort, merge overlapping or adjacent ranges, and cap the list. Over the cap, the ranges collapse to
 * one covering range: an extra day in the warning is safe, a dropped day is not.
 */
export function normalizeIntervals(intervals: readonly DateInterval[]): DateInterval[] {
  const sorted = intervals
    .flatMap((interval) => usable(interval) ?? [])
    .sort((a, b) => startOf(a.from) - startOf(b.from) || startOf(a.to) - startOf(b.to));
  const merged: DateInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // Adjacent days merge too: 1–2 March and 3–4 March are one incomplete run.
    if (last && startOf(interval.from) <= startOf(last.to) + DAY_MS) {
      if (startOf(interval.to) > startOf(last.to)) last.to = interval.to;
      continue;
    }
    merged.push({ ...interval });
  }
  if (merged.length <= SPEND_STATE_MAX_INTERVALS) return merged;
  return [{ from: merged[0]!.from, to: merged[merged.length - 1]!.to }];
}

/** Records a range that an import could not complete. */
export function addIncomplete(state: SpendState, interval: DateInterval): SpendState {
  const next = usable(interval);
  if (!next) return state;
  return { incomplete: normalizeIntervals([...(state.incomplete ?? []), next]) };
}

/** Removes the part of the stored ranges a complete read covered, splitting when it covers the middle. */
export function completeInterval(state: SpendState, interval: DateInterval): SpendState {
  const done = usable(interval);
  if (!done) return state;
  const doneFrom = startOf(done.from);
  const doneTo = startOf(done.to);
  const kept: DateInterval[] = [];
  for (const stored of state.incomplete ?? []) {
    const from = startOf(stored.from);
    const to = startOf(stored.to);
    if (doneFrom <= from && doneTo >= to) continue;
    if (doneTo < from || doneFrom > to) {
      kept.push({ ...stored });
      continue;
    }
    if (doneFrom > from) kept.push({ from: stored.from, to: dayOf(doneFrom - DAY_MS) });
    if (doneTo < to) kept.push({ from: dayOf(doneTo + DAY_MS), to: stored.to });
  }
  const incomplete = normalizeIntervals(kept);
  return incomplete.length ? { incomplete } : {};
}

/** The stored ranges that intersect a report window, trimmed to the intersection. */
export function incompleteInWindow(state: SpendState, window: DateInterval): DateInterval[] {
  const view = usable(window);
  if (!view) return [];
  const viewFrom = startOf(view.from);
  const viewTo = startOf(view.to);
  return (state.incomplete ?? []).flatMap((stored) => {
    const from = Math.max(startOf(stored.from), viewFrom);
    const to = Math.min(startOf(stored.to), viewTo);
    return from <= to ? [{ from: dayOf(from), to: dayOf(to) }] : [];
  });
}

/** One connection's incomplete coverage for a report window. */
export interface IncompleteSpend {
  platform: 'meta' | 'google';
  intervals: DateInterval[];
}

/**
 * The incomplete spend ranges that affect one report. A connection of a platform the report reads
 * contributes every stored range overlapping the window; there is no per-account filter on the
 * spend table, so any incomplete import for that platform can leave its cost short.
 */
export function incompleteSpendFor(
  connections: readonly { connector: string; spendState: unknown }[],
  window: { since: string; until: string; platform?: 'meta' | 'google' },
): IncompleteSpend[] {
  const platforms: ('meta' | 'google')[] =
    window.platform === 'meta' ? ['meta'] : window.platform === 'google' ? ['google'] : ['meta', 'google'];
  const affected: IncompleteSpend[] = [];
  for (const platform of platforms) {
    const connector = platform === 'meta' ? 'meta_ads' : 'google_ads';
    const intervals = connections
      .filter((connection) => connection.connector === connector)
      .flatMap((connection) => incompleteInWindow(parseSpendState(connection.spendState), { from: window.since, to: window.until }));
    if (!intervals.length) continue;
    affected.push({ platform, intervals: normalizeIntervals(intervals) });
  }
  return affected;
}

/** A note naming every incomplete range, or null when the report's cost is complete. */
export function incompleteSpendNote(affected: readonly IncompleteSpend[]): string | null {
  if (!affected.length) return null;
  const ranges = affected.map(
    (entry) => `${entry.platform} ${entry.intervals.map((i) => (i.from === i.to ? i.from : `${i.from} to ${i.to}`)).join(', ')}`,
  );
  return `Spend is incomplete for ${ranges.join('; ')}: an import stopped at the provider page limit for those days, so cost is missing, CPA is understated and ROAS is overstated. Import a narrower date range to fill the gap.`;
}
