import {
  DEFAULT_PURPOSES,
  type Purposes,
  publishedSingleton,
  type SegmentCondition,
  type SegmentDefinition,
  type TrackingPlan,
} from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import { currentConsent, purposeAllowed } from '@agentic-marketing/profiles';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';

// Segment evaluation as set algebra over profile ids. The same code serves batch recomputation
// (scope: everyone) and streaming (scope: the people an event just touched). Traits are read
// from Postgres, events counted in ClickHouse; events not yet stored there can be passed as
// `pending` so a condition sees the event that triggered the evaluation.

export interface EvalContext {
  tx: Tx;
  workspaceId: string;
  events: EventStore;
  /** Evaluate only these profiles; all active profiles when omitted. */
  scope?: string[];
  /** Just-applied events per profile that ClickHouse may not have yet. */
  pending?: Map<string, BusEvent[]>;
  /** Published segment definitions by id, for { segment } references. */
  loadSegment?: (id: string) => Promise<SegmentDefinition | null>;
  now?: Date;
  // Caches for one evaluation.
  _universe?: Promise<Set<string>>;
  _purposes?: Promise<Purposes>;
  _plan?: Promise<TrackingPlan | null>;
  _stack?: string[];
}

const SECONDS: Record<string, number> = { W: 604_800, D: 86_400, H: 3_600, M: 60 };
export function durationSeconds(iso: string): number {
  let total = 0;
  for (const [, n, unit] of iso
    .replace(/^P/, '')
    .replace('T', '')
    .matchAll(/(\d+)([WDHM])/g))
    total += Number(n) * SECONDS[unit];
  return total;
}

function universe(ctx: EvalContext) {
  ctx._universe ??= (async () => {
    const rows = await ctx.tx
      .select({ id: schema.profiles.id })
      .from(schema.profiles)
      .where(
        and(isNull(schema.profiles.mergedInto), ctx.scope ? inArray(schema.profiles.id, ctx.scope.length ? ctx.scope : ['-']) : undefined),
      );
    return new Set(rows.map((r) => r.id));
  })();
  return ctx._universe;
}

const minus = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => !b.has(x)));
const intersect = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));

export async function evaluate(cond: SegmentCondition, ctx: EvalContext): Promise<Set<string>> {
  if ('all' in cond) {
    let acc = await universe(ctx);
    for (const c of cond.all) {
      if (!acc.size) break;
      acc = intersect(acc, await evaluate(c, ctx));
    }
    return acc;
  }
  if ('any' in cond) {
    const acc = new Set<string>();
    for (const c of cond.any) for (const id of await evaluate(c, ctx)) acc.add(id);
    return acc;
  }
  if ('not' in cond) return minus(await universe(ctx), await evaluate(cond.not, ctx));
  if ('trait' in cond) return traitSet(cond, ctx);
  if ('event' in cond) return eventSet(cond, ctx);
  if ('consent' in cond) return consentSet(cond.consent, ctx);
  return segmentSet(cond.segment, ctx);
}

async function traitSet(c: Extract<SegmentCondition, { trait: string }>, ctx: EvalContext): Promise<Set<string>> {
  const rows = await ctx.tx
    .select({ id: schema.profiles.id })
    .from(schema.profiles)
    .where(
      and(
        isNull(schema.profiles.mergedInto),
        ctx.scope ? inArray(schema.profiles.id, ctx.scope.length ? ctx.scope : ['-']) : undefined,
        await traitPredicate(c, ctx),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** A trait condition as a predicate on the profiles table (never NULL). Personal traits are refused. */
export async function traitPredicate(
  c: Extract<SegmentCondition, { trait: string }>,
  ctx: Pick<EvalContext, 'tx' | '_plan'>,
): Promise<SQL> {
  ctx._plan ??= publishedSingleton(ctx.tx, 'tracking_plan');
  const plan = await ctx._plan;
  const def = plan?.traits.find((t) => t.name === c.trait);
  if ((def && def.pii !== 'none') || ['email', 'phone', 'name', 'firstName', 'lastName', 'address', 'birthday'].includes(c.trait))
    throw new AppError(
      'invalid_input',
      `"${c.trait}" is personal data, which is encrypted per person and cannot be used in segments. Use a non-personal trait.`,
    );
  const t = sql`${schema.profiles.traits}`;
  const v = c.value;
  const text = sql`(${t} ->> ${c.trait})`;
  const num = sql`(CASE WHEN jsonb_typeof(${t} -> ${c.trait}) = 'number' THEN (${t} ->> ${c.trait})::numeric END)`;
  const cmp = (op: string) => (typeof v === 'number' ? sql`${num} ${sql.raw(op)} ${v}` : sql`${text} ${sql.raw(op)} ${String(v)}`);
  const conditions: Record<string, () => SQL> = {
    eq: () => cmp('='),
    neq: () => sql`(${text} IS DISTINCT FROM ${String(v)})`,
    gt: () => cmp('>'),
    gte: () => cmp('>='),
    lt: () => cmp('<'),
    lte: () => cmp('<='),
    in: () =>
      sql`${text} = ANY(${sql.raw('ARRAY[')}${sql.join(
        (Array.isArray(v) ? v : [v]).map((x) => sql`${String(x)}`),
        sql`, `,
      )}${sql.raw(']::text[]')})`,
    contains: () => sql`${text} ILIKE ${`%${String(v).replace(/[%_\\]/g, (m) => `\\${m}`)}%`}`,
    exists: () => sql`${t} ? ${c.trait}`,
    not_exists: () => sql`NOT (${t} ? ${c.trait})`,
  };
  if (v === undefined && !['exists', 'not_exists'].includes(c.op))
    throw new AppError('invalid_input', `Trait condition "${c.trait} ${c.op}" needs a value.`);
  return sql`COALESCE((${conditions[c.op]()}), false)`;
}

async function identifiersByProfile(ctx: EvalContext, profileIds?: string[]) {
  const rows = await ctx.tx
    .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
    .from(schema.identifiers)
    .where(
      and(
        inArray(schema.identifiers.type, ['anonymous_id', 'user_id']),
        profileIds ? inArray(schema.identifiers.profileId, profileIds.length ? profileIds : ['-']) : undefined,
      ),
    );
  return rows;
}

async function eventSet(c: Extract<SegmentCondition, { event: string }>, ctx: EvalContext): Promise<Set<string>> {
  const since = c.within ? durationSeconds(c.within) : undefined;
  const now = (ctx.now ?? new Date()).getTime();
  const min = c.count?.gte ?? (c.count?.lte === undefined ? 1 : 0);
  const max = c.count?.lte;
  const all = await universe(ctx);

  const ids = ctx.scope ? await identifiersByProfile(ctx, [...all]) : undefined;
  const pendingIds = [...(ctx.pending?.values() ?? [])].flat().map((e) => e.messageId);
  const counts = await ctx.events.countEvents(ctx.workspaceId, {
    name: c.event,
    where: c.where,
    sinceSeconds: since,
    ids: ids
      ? {
          anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
          userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
        }
      : undefined,
    excludeEventIds: pendingIds.length ? pendingIds : undefined,
  });

  // Identifier counts → profile counts. A row can carry both ids; count it once.
  const map = new Map<string, string>();
  for (const i of ids ?? (await identifiersByProfile(ctx))) map.set(`${i.type}:${i.value}`, i.profileId);
  const perProfile = new Map<string, number>();
  for (const r of counts) {
    const p = (r.userId && map.get(`user_id:${r.userId}`)) || (r.anonymousId && map.get(`anonymous_id:${r.anonymousId}`));
    if (p) perProfile.set(p, (perProfile.get(p) ?? 0) + r.count);
  }
  for (const [p, evs] of ctx.pending ?? [])
    for (const e of evs)
      if (
        e.name === c.event &&
        (!since || Date.parse(e.timestamp) >= now - since * 1000) &&
        Object.entries(c.where ?? {}).every(([k, v]) => String(e.properties[k]) === String(v))
      )
        perProfile.set(p, (perProfile.get(p) ?? 0) + 1);

  const ok = (n: number) => n >= min && (max === undefined || n <= max);
  // "At most n times" includes everyone who never did it.
  if (ok(0)) return new Set([...all].filter((p) => ok(perProfile.get(p) ?? 0)));
  return new Set([...perProfile].filter(([p, n]) => all.has(p) && ok(n)).map(([p]) => p));
}

async function consentSet(purpose: string, ctx: EvalContext): Promise<Set<string>> {
  ctx._purposes ??= publishedSingleton(ctx.tx, 'purposes').then((p) => p?.purposes ?? DEFAULT_PURPOSES);
  const p = (await ctx._purposes).find((x) => x.key === purpose);
  if (!p) throw new AppError('invalid_input', `Unknown purpose "${purpose}" in a consent condition. See purposes.list.`);
  const all = await universe(ctx);
  const states = await ctx.tx
    .select({
      profileId: schema.consentState.profileId,
      purpose: schema.consentState.purpose,
      status: schema.consentState.status,
      channel: schema.consentState.channel,
      updatedAt: schema.consentState.updatedAt,
    })
    .from(schema.consentState)
    .where(
      and(
        eq(schema.consentState.purpose, purpose),
        ctx.scope ? inArray(schema.consentState.profileId, ctx.scope.length ? ctx.scope : ['-']) : undefined,
      ),
    );
  const byProfile = new Map<string, typeof states>();
  for (const s of states) byProfile.set(s.profileId, [...(byProfile.get(s.profileId) ?? []), s]);
  return new Set([...all].filter((id) => purposeAllowed(p.basis, currentConsent(byProfile.get(id) ?? [], purpose)?.status)));
}

async function segmentSet(id: string, ctx: EvalContext): Promise<Set<string>> {
  const stack = ctx._stack ?? [];
  if (stack.includes(id)) throw new AppError('invalid_input', `Segments refer to each other in a loop: ${[...stack, id].join(' → ')}`);
  const def = await ctx.loadSegment?.(id);
  if (!def) throw new AppError('invalid_input', `Segment ${id} has no published version.`);
  // Static and snapshot segments are explicit lists; their membership changes only through the
  // audience commands, so evaluating the source rule again would contradict the stored list.
  if (def.mode !== 'dynamic') {
    const rows = await ctx.tx
      .select({ profileId: schema.segmentMemberships.profileId })
      .from(schema.segmentMemberships)
      .innerJoin(
        schema.profiles,
        and(
          eq(schema.profiles.workspaceId, ctx.workspaceId),
          eq(schema.profiles.id, schema.segmentMemberships.profileId),
          isNull(schema.profiles.mergedInto),
        ),
      )
      .where(
        and(
          eq(schema.segmentMemberships.segmentId, id),
          ctx.scope ? inArray(schema.segmentMemberships.profileId, ctx.scope.length ? ctx.scope : ['-']) : undefined,
        ),
      );
    return new Set(rows.map((r) => r.profileId));
  }
  if (!def.condition) throw new AppError('invalid_input', `Segment ${id} has no condition.`);
  ctx._stack = [...stack, id];
  try {
    return await evaluate(def.condition, ctx);
  } finally {
    ctx._stack = stack;
  }
}

/** Whether an event can change a person's membership: a named event, or anything that changes traits or consent. */
export function relevant(cond: SegmentCondition, e: BusEvent): boolean {
  if ('all' in cond) return cond.all.some((c) => relevant(c, e));
  if ('any' in cond) return cond.any.some((c) => relevant(c, e));
  if ('not' in cond) return relevant(cond.not, e);
  if ('event' in cond) return cond.event === e.name;
  if ('segment' in cond) return true;
  // Form confirmations (frm_) and imports (imp_) carry no consent field; the consent hook records theirs.
  if ('consent' in cond && /^(frm|imp)_/.test(e.sourceId)) return true;
  return Object.keys(e.traits).length > 0 || Object.keys(e.consent).length > 0 || e.type === 'identify';
}
