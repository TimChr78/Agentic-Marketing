import type { Out } from '../../app/api';
import { formatDateTime } from '../../ui/time';

// Deliverability (#508) reads one health summary, one trend and one DNS list. This module keeps the
// decisions pure: when a rate may be shown, how a server status becomes an operational state, how a
// trend point is withheld, and what fix belongs beside a failed DNS check. Nothing here invents a
// threshold, a pause state or a DNS record.

export type Health = Out<'deliverability.health'>;
export type Rates = Health['email']['marketing'];
export type Thresholds = Health['thresholds'];
export type Report = Out<'sendingDomains.list'>['domains'][number];
export type Trend = Out<'deliverability.trend'>;
export type TrendPoint = Trend['points'][number];

export type Channel = 'email' | 'sms';
export type StreamKind = 'marketing' | 'transactional';
export type StreamKey = `${Channel}.${StreamKind}`;

export interface Stream {
  key: StreamKey;
  label: string;
  channel: Channel;
  stream: StreamKind;
  marketing: boolean;
}

export const STREAMS: readonly Stream[] = [
  { key: 'email.marketing', label: 'E-mail · marketing', channel: 'email', stream: 'marketing', marketing: true },
  { key: 'email.transactional', label: 'E-mail · transactional', channel: 'email', stream: 'transactional', marketing: false },
  { key: 'sms.marketing', label: 'SMS · marketing', channel: 'sms', stream: 'marketing', marketing: true },
  { key: 'sms.transactional', label: 'SMS · transactional', channel: 'sms', stream: 'transactional', marketing: false },
] as const;

export function streamOf(key: StreamKey): Stream {
  return STREAMS.find((stream) => stream.key === key) ?? (STREAMS[0] as Stream);
}

export function ratesOf(health: Health, key: StreamKey): Rates {
  const stream = streamOf(key);
  return health[stream.channel][stream.stream];
}

/** Rates are server fractions; display percentages. Thresholds drop needless trailing zeros. */
export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

export function pctThreshold(fraction: number): string {
  return `${Number((fraction * 100).toFixed(3))}%`;
}

export type WithheldReason = 'none' | 'no-volume' | 'below-volume' | 'unavailable';

export interface RateView {
  /** The rate as a percentage, or null when it is withheld. */
  value: number | null;
  withheld: WithheldReason;
}

/**
 * A rate needs a real denominator and the policy's minimum sample. Zero sends is "No data"; a
 * positive sample below `minVolume` is "Below evaluation volume"; both withhold the rate (em dash)
 * even if the server returned a fraction, per DECISIONS D32. A null rate on a sufficient sample is
 * simply Unavailable, never 0%.
 */
export function rateView(sent: number, minVolume: number, rate: number | null): RateView {
  if (sent <= 0) return { value: null, withheld: 'no-volume' };
  if (sent < minVolume) return { value: null, withheld: 'below-volume' };
  return { value: rate === null ? null : rate * 100, withheld: rate === null ? 'unavailable' : 'none' };
}

export type StreamState = 'no-data' | 'below-volume' | 'healthy' | 'warning' | 'paused' | 'above-stop';

export interface StreamVerdict {
  state: StreamState;
  label: string;
  tone: 'neutral' | 'good' | 'warn';
  /** True only when the sample reached the policy's evaluation volume. */
  evaluated: boolean;
  /** Why rates are withheld, or the server's reason at volume. */
  detail: string;
  reason: string | null;
}

/**
 * The stream's own returned status decides healthy / warning / above-stop. "Sending paused" is only
 * claimed for marketing with auto-pause on; a transactional stream and an auto-pause-off workspace
 * are "Above stop threshold". Zero volume is never inferred to be paused.
 */
export function streamVerdict(
  rates: Rates,
  thresholds: Thresholds,
  options: { windowDays: number; marketing: boolean; autoPause: boolean },
): StreamVerdict {
  if (rates.sent <= 0) {
    return {
      state: 'no-data',
      label: 'No data',
      tone: 'neutral',
      evaluated: false,
      detail: `No sends in the last ${options.windowDays} days.`,
      reason: null,
    };
  }
  if (rates.sent < thresholds.minVolume) {
    return {
      state: 'below-volume',
      label: 'Below evaluation volume',
      tone: 'neutral',
      evaluated: false,
      detail: `Not evaluated · ${rates.sent.toLocaleString()} / ${thresholds.minVolume.toLocaleString()} required`,
      reason: null,
    };
  }
  if (rates.status === 'paused') {
    if (options.marketing && options.autoPause) {
      return {
        state: 'paused',
        label: 'Sending paused',
        tone: 'warn',
        evaluated: true,
        detail: 'Marketing messages are held until the rate falls or the policy changes.',
        reason: rates.reason,
      };
    }
    return {
      state: 'above-stop',
      label: 'Above stop threshold',
      tone: 'warn',
      evaluated: true,
      detail: options.marketing ? 'Auto-pause is off; this is a warning only.' : 'Transactional sending is not paused by this policy.',
      reason: rates.reason,
    };
  }
  if (rates.status === 'warn') {
    return {
      state: 'warning',
      label: 'Warning',
      tone: 'warn',
      evaluated: true,
      detail: 'Within the stop threshold, above the complaint warning.',
      reason: rates.reason,
    };
  }
  return {
    state: 'healthy',
    label: 'Healthy',
    tone: 'good',
    evaluated: true,
    detail: 'Within today’s policy thresholds.',
    reason: rates.reason,
  };
}

export function allStreamsEmpty(health: Health): boolean {
  return STREAMS.every((stream) => ratesOf(health, stream.key).sent <= 0);
}

/** A trend point's rate is withheld on a zero denominator or below the policy's minimum volume. */
export function pointRate(point: TrendPoint, kind: 'bounce' | 'complaint', minVolume: number): RateView {
  const rate = kind === 'bounce' ? point.bounceRate : point.complaintRate;
  return rateView(point.sent, minVolume, rate);
}

export function pointNumerator(point: TrendPoint, kind: 'bounce' | 'complaint'): number {
  return kind === 'bounce' ? point.bounced : point.complained;
}

export function withheldCopy(withheld: WithheldReason): string {
  switch (withheld) {
    case 'below-volume':
      return 'Below evaluation volume';
    case 'no-volume':
      return 'No volume';
    case 'unavailable':
      return 'Unavailable';
    default:
      return '';
  }
}

/** A moment for a read: never the epoch, never a fabricated "now". */
export function formatMoment(iso: string | null | undefined): string {
  if (!iso) return 'Unavailable';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return 'Unavailable';
  return formatDateTime(iso, { zone: true });
}

/** A window bound in the read's own zone, with the zone name so DST changes are visible. */
export function formatWindow(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return 'Unavailable';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return formatDateTime(iso, { zone: true });
  }
}

export function isNotFound(message: string | null | undefined): boolean {
  return !!message && /not[\s_-]?found|does not exist|no such/i.test(message);
}

/** Trimmed, unique selectors in the caller's order; the server accepts at most five. */
export function cleanSelectors(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length === 5) break;
  }
  return out;
}

export function sameSelectors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type DnsOverall = { label: string; tone: 'neutral' | 'good' | 'warn' };

/**
 * No selector means DKIM was not checked, so the domain never gets a green overall pass. The
 * returned `ok` is still the server's own SPF/DKIM/DMARC conjunction; the UI only qualifies it.
 */
export function dnsOverall(report: Report): DnsOverall {
  if (report.dkim.length === 0) return { label: 'DKIM not checked', tone: 'neutral' };
  return report.ok ? { label: 'Records pass', tone: 'good' } : { label: 'Needs attention', tone: 'warn' };
}

export function dkimFix(): string {
  return 'Ask your DNS administrator to verify the provider’s record for this selector';
}

/** Returned advice first; otherwise the contract's neutral instruction. Never a generated record. */
export function checkFix(advice: string | null | undefined, fallback: string): string {
  return advice?.trim() || fallback;
}

export function recordsUnavailableCopy(): string {
  return 'A failed lookup can look like a missing record.';
}

export function hasNoRate(points: readonly TrendPoint[], kind: 'bounce' | 'complaint', minVolume: number): boolean {
  return points.every((point) => pointRate(point, kind, minVolume).value === null);
}
