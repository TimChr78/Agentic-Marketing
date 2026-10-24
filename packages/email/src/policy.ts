import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicy, type Purposes, publishedSingleton } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';

// The delivery policy (Phase 7) applies to every marketing message at the moment it would be
// sent, whoever asked for it (journey, broadcast, API, agent): frequency caps, quiet hours, and a
// pause while the stream's bounce or complaint rate is too high. Transactional messages (contract,
// legal obligation) are never held back.

export type Channel = 'email' | 'sms' | 'push';
export type Hold = { ok: true } | { ok: false; reason: string } | { ok: 'later'; until: Date; reason: string };

const SENT = ['sending', 'sent', 'delivered', 'bounced', 'complained'] as const;
export const isMarketing = (basis: string) => basis !== 'contract' && basis !== 'legal_obligation';

export async function deliveryPolicy(tx: Tx): Promise<DeliveryPolicy> {
  return (await publishedSingleton(tx, 'delivery_policy')) ?? DEFAULT_DELIVERY_POLICY;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Minutes past midnight in a time zone. */
function localMinutes(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** When quiet hours (local time) end, or null when it is not quiet now. */
export function quietUntil(now: Date, window: { start: string; end: string }, timeZone: string): Date | null {
  const t = localMinutes(now, timeZone);
  const [s, e] = [minutes(window.start), minutes(window.end)];
  const quiet = s <= e ? t >= s && t < e : t >= s || t < e;
  if (!quiet) return null;
  const wait = (e - t + 1440) % 1440;
  return new Date(Math.ceil((now.getTime() + wait * 60_000) / 60_000) * 60_000);
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
  message: { id: string; createdAt: Date; profileId: string; channel: Channel; purpose: string; basis: string; timezone?: unknown },
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
          gte(schema.messages.createdAt, new Date(now.getTime() - cap.days * 86_400_000)),
          // Earlier messages still being sent count too, so a batch cannot slip past the cap.
          or(
            inArray(schema.messages.status, ['sent', 'delivered', 'bounced', 'complained']),
            and(inArray(schema.messages.status, [...SENT]), lt(schema.messages.createdAt, message.createdAt)),
          ),
        ),
      );
    if (n >= cap.max)
      return {
        ok: false,
        reason: `frequency_cap: ${n} ${{ email: 'e-mails', sms: 'texts', push: 'notifications' }[message.channel]} in ${cap.days} days (at most ${cap.max})`,
      };
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
