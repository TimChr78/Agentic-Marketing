import { ANALYTICS_DIMENSIONS, ANALYTICS_MEASURES } from '../../lib/labels';
import { wallTimeToIso } from '../../ui/time';

// Analytics links from Home and the broadcast Report use one format: `YYYY-MM-DD` date-only
// boundaries, inclusive, plus optional comma-separated measures/dimensions and a broadcast id.
// Everything here is validated before it becomes query state, so a hand-edited link never asks the
// metric layer for an unknown measure, a malformed date or another source's filter.

export const DEFAULT_ANALYTICS_MEASURES = ['email.sent', 'email.delivered', 'email.click_rate'];
export const DEFAULT_ANALYTICS_DIMENSIONS = ['day'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BROADCAST_ID = /^bct_[0-9a-f]{32}$/;
const MAX_MEASURES = 10;
const MAX_DIMENSIONS = 3;

const dateInput = (date: Date) => date.toISOString().slice(0, 10);

const isDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export interface AnalyticsParams {
  /** The first day, inclusive (YYYY-MM-DD). */
  from: string;
  /** The last day, inclusive (YYYY-MM-DD). */
  to: string;
  measures: string[];
  dimensions: string[];
  /** A broadcast artifact id, or null for every send. */
  broadcast: string | null;
}

export interface AnalyticsParamsResult {
  params: AnalyticsParams;
  /** Query parameters that were present but not usable; the defaults apply instead. */
  invalid: string[];
}

const list = (raw: string): string[] => [
  ...new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  ),
];

/**
 * The validated initial state for Analytics. Missing parameters keep the page's own default
 * (the last 30 days through today); present but invalid ones fall back and are named in `invalid`.
 */
export function analyticsParams(search: URLSearchParams, now = new Date()): AnalyticsParamsResult {
  const invalid: string[] = [];

  const today = dateInput(now);
  const thirtyDaysAgo = dateInput(new Date(now.getTime() - 29 * 86_400_000));
  let from = thirtyDaysAgo;
  let to = today;
  const rawFrom = search.get('from');
  const rawTo = search.get('to');
  if (rawFrom !== null || rawTo !== null) {
    if (!rawFrom || !rawTo || !isDate(rawFrom) || !isDate(rawTo) || rawFrom > rawTo) invalid.push('from/to');
    else {
      from = rawFrom;
      to = rawTo;
    }
  }

  let measures = DEFAULT_ANALYTICS_MEASURES;
  const rawMeasures = search.get('measures');
  if (rawMeasures !== null) {
    const parsed = list(rawMeasures);
    const valid = parsed.filter((id) => id in ANALYTICS_MEASURES);
    if (!valid.length || valid.length !== parsed.length || valid.length > MAX_MEASURES) invalid.push('measures');
    else measures = valid;
  }

  let dimensions = DEFAULT_ANALYTICS_DIMENSIONS;
  const rawDimensions = search.get('dimensions');
  if (rawDimensions !== null) {
    const parsed = list(rawDimensions);
    const valid = parsed.filter((id) => id in ANALYTICS_DIMENSIONS);
    if (valid.length !== parsed.length || valid.length > MAX_DIMENSIONS) invalid.push('dimensions');
    else dimensions = valid;
  }

  let broadcast: string | null = null;
  const rawBroadcast = search.get('broadcast');
  if (rawBroadcast) {
    if (BROADCAST_ID.test(rawBroadcast)) broadcast = rawBroadcast;
    else invalid.push('broadcast');
  }

  return { params: { from, to, measures, dimensions, broadcast }, invalid };
}

/**
 * The instants a `YYYY-MM-DD` range covers in the workspace's time zone (#442 re-review): Home and
 * the broadcast report count local calendar days, so Analytics must too. The end is the last
 * millisecond before the next local midnight (the query compares with `<= to`); local midnights
 * are resolved per day, so a DST change inside the range neither shortens nor lengthens it.
 */
export function dayStartIso(day: string, zone: string): string {
  const local = wallTimeToIso(`${day}T00:00`, zone);
  return new Date(local ?? `${day}T00:00:00.000Z`).toISOString();
}

export function dayEndIso(day: string, zone: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
  return new Date(new Date(dayStartIso(next, zone)).getTime() - 1).toISOString();
}
