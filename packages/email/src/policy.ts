import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicy, type Purposes, publishedSingleton } from '@agentic-marketing/artifacts';
import { autonomySettings } from '@agentic-marketing/commands';
import { AppError, zonedInstant, zonedParts } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

// The delivery policy (Phase 7) applies to every marketing message at the moment it would be
// sent, whoever asked for it (journey, broadcast, API, agent): frequency caps, quiet hours, and a
// pause while the stream's bounce or complaint rate is too high. Transactional messages (contract,
// legal obligation) are never held back.

export type Channel = 'email' | 'sms' | 'push';
export type Hold = { ok: true } | { ok: false; reason: string } | { ok: 'later'; until: Date; reason: string };

/** Statuses of a completed contact: the provider accepted the message and its send time is known. */
export const CONTACTED = ['sent', 'delivered', 'bounced', 'complained'] as const;
/** A reservation: claimed for sending, or still queued behind the worker. Both count conservatively. */
const IN_FLIGHT = ['queued', 'sending'] as const;
export const isMarketing = (basis: string) => basis !== 'contract' && basis !== 'legal_obligation';

/**
 * One message counted towards a cap, for both the channel frequency cap and the cross-agent
 * contact pressure:
 *
 * - a completed contact ages from the moment the provider accepted it (#453), falling back to the
 *   last status change for a row written before `sent_at` existed or one the background backfill
 *   has not reached yet; a message that waited days for
 *   quiet hours, a pause or a retry therefore consumes the window from its real send time;
 * - an in-flight reservation counts until it completes, however long ago it was enqueued (#452).
 *   A message queued eight days ago and still queued or sending has not been sent yet, so it must
 *   still take its slot in a seven-day window; aging it out at enqueue time let two old queued
 *   messages both pass a max=1 cap. Within the in-flight set a peer only counts when it is *before*
 *   this message in `(created_at, id)` order: the later id is the one held back, deterministically.
 *   Queued rows are counted as well as claimed ones: a peer another worker has not claimed yet must
 *   still take its place, or two workers could admit one message each before either saw the other.
 *   The cap decision is also serialized per person by `checkPolicy`, so two workers cannot read a
 *   stale in-flight set at the same instant.
 */
function countedContact(message: { id: string; createdAt: Date }, now: Date, days: number) {
  const since = new Date(now.getTime() - days * 86_400_000);
  return or(
    and(
      inArray(schema.messages.status, [...CONTACTED]),
      or(gte(schema.messages.sentAt, since), and(isNull(schema.messages.sentAt), gte(schema.messages.updatedAt, since))),
    ),
    and(
      inArray(schema.messages.status, [...IN_FLIGHT]),
      sql`(${schema.messages.createdAt}, ${schema.messages.id}) < (${message.createdAt}, ${message.id})`,
    ),
  );
}

export async function deliveryPolicy(tx: Tx): Promise<DeliveryPolicy> {
  return (await publishedSingleton(tx, 'delivery_policy')) ?? DEFAULT_DELIVERY_POLICY;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A local wall-clock reading as minutes on the local calendar (a "pseudo-UTC" key, not an instant). */
function localClock(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d) / MINUTE + p.h * 60 + p.min;
}

/** Whole minutes east of UTC at an instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const rounded = Math.floor(at.getTime() / MINUTE) * MINUTE;
  const p = zonedParts(new Date(rounded), timeZone);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - rounded) / MINUTE;
}

/**
 * The earliest actual instant at which the local clock reaches a wall-clock time on a date.
 * A fall-back fold has two instants with that reading; the earlier one wins. A spring-forward
 * gap has none; the transition itself is then the first instant past the skipped reading.
 */
function wallClockEnd(y: number, m: number, d: number, minuteOfDay: number, timeZone: string, after: Date): Date {
  const wall = Date.UTC(y, m - 1, d) + minuteOfDay * MINUTE;
  const target = wall / MINUTE;
  // Offsets on both sides of any transition near this date; a transition shifts the offset by
  // 30, 60 or 120 minutes in current tzdata, and ±36h covers date-line jumps too.
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) offsets.add(offsetMinutes(new Date(wall + hours * 3_600_000), timeZone));
  const exact = [...offsets]
    .map((offset) => wall - offset * MINUTE)
    .filter((ts) => ts > after.getTime() && localClock(new Date(ts), timeZone) === target)
    .sort((a, b) => a - b);
  if (exact.length) return new Date(exact[0] as number);

  let below = Number.NEGATIVE_INFINITY;
  let above = Number.POSITIVE_INFINITY;
  for (const offset of offsets) {
    const ts = wall - offset * MINUTE;
    const clock = localClock(new Date(ts), timeZone);
    if (clock < target) below = Math.max(below, ts);
    else if (clock > target) above = Math.min(above, ts);
  }
  if (!Number.isFinite(below) || !Number.isFinite(above)) {
    // Defensive: no transition explains the missing reading. Keep the old zoned-instant guess.
    return zonedInstant(y, m, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, timeZone);
  }
  // The skipped reading is in a spring-forward gap. Find the first minute at or after the jump.
  let lo = below;
  let hi = above;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (localClock(new Date(mid), timeZone) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** When quiet hours (local time) end, or null when it is not quiet now. */
export function quietUntil(now: Date, window: { start: string; end: string }, timeZone: string): Date | null {
  const p = zonedParts(now, timeZone);
  const t = p.h * 60 + p.min;
  const [s, e] = [minutes(window.start), minutes(window.end)];
  const quiet = s <= e ? t >= s && t < e : t >= s || t < e;
  if (!quiet) return null;
  // The instant of the end reading, not a wall-clock minute count: a transition between now and
  // the end changes the elapsed real time. The end is today when it is still ahead today (also
  // for the after-midnight part of an overnight window), otherwise tomorrow.
  const date = new Date(Date.UTC(p.y, p.m - 1, p.d) + (t < e ? 0 : DAY));
  let until = wallClockEnd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), e, timeZone, now);
  const quietAt = (at: Date) => {
    const p = zonedParts(at, timeZone);
    const minute = p.h * 60 + p.min;
    return s <= e ? minute >= s && minute < e : minute >= s || minute < e;
  };
  // A clock rollback can cross the START backwards, leaving quiet hours before the end
  // reading occurs (01:45 -> 01:00 in a 01:30–02:30 window). Inspect intervening offset
  // transitions as well as the nominal end, in bounded six-hour brackets.
  let at = Math.floor(now.getTime() / MINUTE) * MINUTE;
  let offset = offsetMinutes(new Date(at), timeZone);
  while (at < until.getTime()) {
    const stop = Math.min(at + 6 * 3_600_000, until.getTime());
    const nextOffset = offsetMinutes(new Date(stop), timeZone);
    if (nextOffset !== offset) {
      let lo = at;
      let hi = stop;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
        if (offsetMinutes(new Date(mid), timeZone) === offset) lo = mid;
        else hi = mid;
      }
      if (!quietAt(new Date(hi))) {
        until = new Date(hi);
        break;
      }
      at = hi;
      offset = offsetMinutes(new Date(at), timeZone);
      // The rollback may remain quiet but make today's end reachable again (01:45 ->
      // 01:00 in a 01:30–01:15 overnight window). Recompute rather than keeping tomorrow.
      const q = zonedParts(new Date(at), timeZone);
      const minute = q.h * 60 + q.min;
      const day = new Date(Date.UTC(q.y, q.m - 1, q.d) + (minute < e ? 0 : DAY));
      const nearer = wallClockEnd(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), e, timeZone, new Date(at));
      if (nearer.getTime() < until.getTime()) until = nearer;
    } else at = stop;
  }
  // A date-line jump can skip the entire local end date and land inside the next quiet
  // window. Continue to that window's end rather than returning an instant still quiet.
  if (until.getTime() > now.getTime() && quietAt(until)) return quietUntil(until, window, timeZone);
  return new Date(Math.ceil(until.getTime() / MINUTE) * MINUTE);
}

const validZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export interface Rates {
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  status: 'ok' | 'warn' | 'paused';
  reason: string | null;
}

/** Bounce and complaint rates of a channel's marketing (or transactional) messages over the policy window. */
export async function streamRates(
  tx: Tx,
  policy: DeliveryPolicy,
  purposes: Purposes,
  channel: Channel,
  marketing: boolean,
): Promise<Rates> {
  const keys = purposes.filter((p) => isMarketing(p.basis) === marketing).map((p) => p.key);
  const since = new Date(Date.now() - policy.health.windowDays * 86_400_000);
  const rows = keys.length
    ? await tx
        .select({ status: schema.messages.status, n: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.channel, channel),
            eq(schema.messages.test, false),
            inArray(schema.messages.purpose, keys),
            inArray(schema.messages.status, ['sent', 'delivered', 'bounced', 'complained']),
            gte(schema.messages.createdAt, since),
          ),
        )
        .groupBy(schema.messages.status)
    : [];
  const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const sent = rows.reduce((a, r) => a + r.n, 0);
  const [bounced, complained] = [count('bounced'), count('complained')];
  const bounceRate = sent ? bounced / sent : 0;
  const complaintRate = sent ? complained / sent : 0;
  const h = policy.health;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  let status: Rates['status'] = 'ok';
  let reason: string | null = null;
  if (sent >= h.minVolume) {
    if (complaintRate >= h.complaintStop || bounceRate >= h.bounceStop) {
      status = 'paused';
      reason =
        complaintRate >= h.complaintStop
          ? `complaint rate ${pct(complaintRate)} over ${h.windowDays} days (stop at ${pct(h.complaintStop)})`
          : `bounce rate ${pct(bounceRate)} over ${h.windowDays} days (stop at ${pct(h.bounceStop)})`;
    } else if (complaintRate >= h.complaintWarn) {
      status = 'warn';
      reason = `complaint rate ${pct(complaintRate)} over ${h.windowDays} days (warning at ${pct(h.complaintWarn)})`;
    }
  }
  return { sent, bounced, complained, bounceRate, complaintRate, status, reason };
}

/** One local-midnight point of a deliverability trend: the day it ends, and the boundary itself. */
export interface TrendBoundary {
  /** Workspace-local calendar date that ended at windowTo, e.g. "2026-11-06". */
  day: string;
  /** The local midnight that ends `day`. */
  windowTo: Date;
}

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const dateKey = (at: number) => {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/**
 * The workspace-local daily boundaries whose midnight lies in (from, to], at most 90.
 * Each point ends at local midnight and is labelled with the date that ended there, so a
 * request for the last 30 complete local days (from = midnight 30 days ago, to = today's
 * midnight) returns 30 points, the first labelled 30 days ago.
 */
export function trendBoundaries(from: Date, to: Date, timeZone: string, maxPoints = 90): TrendBoundary[] {
  if (!(from.getTime() < to.getTime())) throw new AppError('invalid_input', '`from` must be before `to`.');
  const start = zonedParts(from, timeZone);
  const startDay = Date.UTC(start.y, start.m - 1, start.d);
  const points: TrendBoundary[] = [];
  for (let cursor = startDay + DAY_MS; ; cursor += DAY_MS) {
    const cursorDate = new Date(cursor);
    const windowTo = zonedInstant(cursorDate.getUTCFullYear(), cursorDate.getUTCMonth() + 1, cursorDate.getUTCDate(), 0, 0, timeZone);
    if (windowTo.getTime() > to.getTime()) break;
    if (windowTo.getTime() <= from.getTime()) continue;
    points.push({ day: dateKey(cursor - DAY_MS), windowTo });
    if (points.length > maxPoints)
      throw new AppError('invalid_input', `The trend is at most ${maxPoints} daily points; narrow \`from\` and \`to\`.`);
  }
  return points;
}

/** One status count at a whole UTC minute, as grouped from the messages table. */
export interface TrendRow {
  /** Epoch minutes: `floor(epoch(created_at) / 60)`. */
  minute: number;
  /** A contacted status; other rows are ignored defensively. */
  status: string;
  n: number;
}

export interface TrendPoint {
  day: string;
  windowFrom: string;
  windowTo: string;
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number | null;
  complaintRate: number | null;
}

/**
 * Rolling creation-window points over a bounded set of minute buckets. The window ends at each
 * local midnight and starts exactly `windowDays * 86_400_000` ms earlier, matching streamRates
 * across DST instead of counting local calendar days. Current statuses are mutually exclusive:
 * sent = sent + delivered + bounced + complained, and a zero denominator yields null rates.
 */
export function trendPoints(boundaries: TrendBoundary[], windowDays: number, rows: TrendRow[]): TrendPoint[] {
  const byMinute = new Map<number, { sent: number; delivered: number; bounced: number; complained: number }>();
  for (const row of rows) {
    if (!(CONTACTED as readonly string[]).includes(row.status)) continue;
    const bucket = byMinute.get(row.minute) ?? { sent: 0, delivered: 0, bounced: 0, complained: 0 };
    bucket[row.status as (typeof CONTACTED)[number]] += row.n;
    byMinute.set(row.minute, bucket);
  }
  const minutes = [...byMinute.keys()].sort((a, b) => a - b);
  const totals = { sent: 0, delivered: 0, bounced: 0, complained: 0 };
  const windowMs = windowDays * DAY_MS;
  let add = 0;
  let remove = 0;
  const points: TrendPoint[] = [];
  for (const boundary of boundaries) {
    const toMinute = Math.floor(boundary.windowTo.getTime() / 60_000);
    const fromMinute = Math.floor((boundary.windowTo.getTime() - windowMs) / 60_000);
    while (add < minutes.length && (minutes[add] as number) < toMinute) {
      const bucket = byMinute.get(minutes[add] as number)!;
      totals.sent += bucket.sent;
      totals.delivered += bucket.delivered;
      totals.bounced += bucket.bounced;
      totals.complained += bucket.complained;
      add += 1;
    }
    while (remove < add && (minutes[remove] as number) < fromMinute) {
      const bucket = byMinute.get(minutes[remove] as number)!;
      totals.sent -= bucket.sent;
      totals.delivered -= bucket.delivered;
      totals.bounced -= bucket.bounced;
      totals.complained -= bucket.complained;
      remove += 1;
    }
    const sent = totals.sent + totals.delivered + totals.bounced + totals.complained;
    points.push({
      day: boundary.day,
      windowFrom: new Date(boundary.windowTo.getTime() - windowMs).toISOString(),
      windowTo: boundary.windowTo.toISOString(),
      sent,
      bounced: totals.bounced,
      complained: totals.complained,
      bounceRate: sent ? totals.bounced / sent : null,
      complaintRate: sent ? totals.complained / sent : null,
    });
  }
  return points;
}

// Rates are read for every marketing message; a short cache keeps a broadcast from re-counting.
const rateCache = new Map<string, { at: number; rates: Rates }>();

/**
 * Whether a message may go now: `ok`, not at all (over a frequency cap), or later (quiet hours,
 * a paused stream). `message` is the one being delivered, excluded from its own cap.
 */
export async function checkPolicy(
  tx: Tx,
  workspaceId: string,
  message: {
    id: string;
    createdAt: Date;
    profileId: string;
    channel: Channel;
    purpose: string;
    basis: string;
    timezone?: unknown;
    /** The agent behind this message (#426); human-originated messages have none. */
    agentId?: string | null;
  },
  purposes: Purposes,
  now = new Date(),
): Promise<Hold> {
  if (!isMarketing(message.basis)) return { ok: true };
  // Serialize the cap decision for this person (#452). The message is already claimed as `sending`
  // (a reservation) before this transaction, so holding one advisory lock per workspace+profile
  // means the next worker sees that reservation before it decides, rather than two workers both
  // reading the same in-flight set. Transaction-scoped: released at commit or rollback.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`message-cap:${workspaceId}:${message.profileId}`}, 0))`);
  const policy = await deliveryPolicy(tx);
  const marketingKeys = purposes.filter((p) => isMarketing(p.basis)).map((p) => p.key);

  for (const cap of policy.frequencyCaps) {
    if (cap.channel !== message.channel) continue;
    const keys = cap.purposes.length ? cap.purposes : marketingKeys;
    if (!keys.includes(message.purpose)) continue;
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.profileId, message.profileId),
          eq(schema.messages.channel, message.channel),
          eq(schema.messages.test, false),
          inArray(schema.messages.purpose, keys),
          ne(schema.messages.id, message.id),
          countedContact(message, now, cap.days),
        ),
      );
    if (n >= cap.max)
      return {
        ok: false,
        reason: `frequency_cap: ${n} ${{ email: 'e-mails', sms: 'texts', push: 'notifications' }[message.channel]} in ${cap.days} days (at most ${cap.max})`,
      };
  }

  // Cross-agent contact pressure (#426): one person's agent-originated marketing messages, across
  // every agent, count towards the same window. Human-originated messages have no agent id.
  if (message.agentId) {
    const [workspace] = await tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
    const settings = autonomySettings(workspace?.autonomy);
    for (const cap of settings.contactPressure) {
      if (cap.channels && !cap.channels.includes(message.channel)) continue;
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.profileId, message.profileId),
            eq(schema.messages.test, false),
            isNotNull(schema.messages.agentId),
            inArray(schema.messages.purpose, marketingKeys),
            cap.channels ? inArray(schema.messages.channel, cap.channels) : undefined,
            ne(schema.messages.id, message.id),
            countedContact(message, now, cap.days),
          ),
        );
      if (n >= cap.max)
        return {
          ok: false,
          reason: `agent_contact_pressure: ${n} agent messages in ${cap.days} days (at most ${cap.max})`,
        };
    }
  }

  for (const q of policy.quietHours) {
    if (q.channel !== message.channel) continue;
    const zone = validZone(message.timezone) ? message.timezone : policy.timezone;
    const until = quietUntil(now, q, zone);
    if (until) return { ok: 'later', until, reason: `quiet_hours: ${q.start}–${q.end} ${zone}` };
  }

  if (policy.health.autoPause) {
    const key = `${workspaceId}:${message.channel}`;
    let cached = rateCache.get(key);
    if (!cached || now.getTime() - cached.at > 60_000) {
      cached = { at: now.getTime(), rates: await streamRates(tx, policy, purposes, message.channel, true) };
      rateCache.set(key, cached);
    }
    if (cached.rates.status === 'paused')
      return { ok: 'later', until: new Date(now.getTime() + 3_600_000), reason: `paused: ${cached.rates.reason}` };
  }
  return { ok: true };
}

/** For tests: forget cached rates. */
export const clearRateCache = () => rateCache.clear();
