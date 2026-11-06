import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicy, type Purposes, publishedSingleton } from '@agentic-marketing/artifacts';
import { autonomySettings } from '@agentic-marketing/commands';
import { zonedInstant, zonedParts } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';

// The delivery policy (Phase 7) applies to every marketing message at the moment it would be
// sent, whoever asked for it (journey, broadcast, API, agent): frequency caps, quiet hours, and a
// pause while the stream's bounce or complaint rate is too high. Transactional messages (contract,
// legal obligation) are never held back.

export type Channel = 'email' | 'sms' | 'push';
export type Hold = { ok: true } | { ok: false; reason: string } | { ok: 'later'; until: Date; reason: string };

/** Statuses of a completed contact: the provider accepted the message and its send time is known. */
const CONTACTED = ['sent', 'delivered', 'bounced', 'complained'] as const;
export const isMarketing = (basis: string) => basis !== 'contract' && basis !== 'legal_obligation';

/**
 * One message counted towards a cap, for both the channel frequency cap and the cross-agent
 * contact pressure:
 *
 * - a completed contact ages from the moment the provider accepted it (#453), falling back to the
 *   last status change for a row written before `sent_at` existed; a message that waited days for
 *   quiet hours, a pause or a retry therefore consumes the window from its real send time;
 * - an in-flight reservation ages from enqueue time, and only counts when it is *before* this
 *   message in `(created_at, id)` order. Two messages queued in one transaction share `created_at`,
 *   so without the id tie-breaker both saw no earlier in-flight peer and passed a max=1 cap (#452).
 *   The later id is the one held back, which is deterministic across workers.
 */
function countedContact(message: { id: string; createdAt: Date }, now: Date, days: number) {
  const since = new Date(now.getTime() - days * 86_400_000);
  return or(
    and(
      inArray(schema.messages.status, [...CONTACTED]),
      gte(sql`coalesce(${schema.messages.sentAt}, ${schema.messages.updatedAt})`, since),
    ),
    and(
      eq(schema.messages.status, 'sending'),
      gte(schema.messages.createdAt, since),
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
