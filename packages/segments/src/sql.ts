import { randomBytes } from 'node:crypto';
import { DEFAULT_PURPOSES, publishedSingleton, type SegmentCondition } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { consentStatusSql, findTopic, purposeAllowedSql, topicSubscribedSql } from '@agentic-marketing/profiles';
import { type SQL, sql } from 'drizzle-orm';
import { durationSeconds, type EvalContext, traitPredicate } from './evaluate';

// Whole-workspace evaluation (refreshes, previews): the condition becomes one SQL predicate over
// profiles, so no list of ids is held in memory. Event conditions are counted in ClickHouse,
// streamed into a temporary table and summed per person in Postgres. The in-memory evaluator in
// evaluate.ts stays for streaming updates, which look at a handful of people at a time.

type SqlContext = Pick<EvalContext, 'tx' | 'workspaceId' | 'events' | 'loadSegment' | '_plan' | '_purposes' | '_stack'>;

const tempName = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

export async function compile(cond: SegmentCondition, ctx: SqlContext): Promise<SQL> {
  if ('all' in cond) {
    if (!cond.all.length) return sql`true`;
    const parts = [];
    for (const c of cond.all) parts.push(await compile(c, ctx));
    return sql`(${sql.join(parts, sql` AND `)})`;
  }
  if ('any' in cond) {
    if (!cond.any.length) return sql`false`;
    const parts = [];
    for (const c of cond.any) parts.push(await compile(c, ctx));
    return sql`(${sql.join(parts, sql` OR `)})`;
  }
  if ('not' in cond) return sql`NOT (${await compile(cond.not, ctx)})`;
  if ('trait' in cond) return traitPredicate(cond, ctx);
  if ('event' in cond) return eventPredicate(cond, ctx);
  if ('consent' in cond) return consentPredicate(cond.consent, ctx);
  if ('topic' in cond) return topicPredicate(cond.topic, ctx);
  const stack = ctx._stack ?? [];
  if (stack.includes(cond.segment))
    throw new AppError('invalid_input', `Segments refer to each other in a loop: ${[...stack, cond.segment].join(' → ')}`);
  const def = await ctx.loadSegment?.(cond.segment);
  if (!def) throw new AppError('invalid_input', `Segment ${cond.segment} has no published version.`);
  // A static/snapshot segment is a stored list; join it rather than recomputing its source rule.
  if (def.mode !== 'dynamic')
    return sql`EXISTS (SELECT 1 FROM segment_memberships sm WHERE sm.workspace_id = ${ctx.workspaceId} AND sm.segment_id = ${cond.segment} AND sm.profile_id = ${schema.profiles.id})`;
  if (!def.condition) throw new AppError('invalid_input', `Segment ${cond.segment} has no condition.`);
  ctx._stack = [...stack, cond.segment];
  try {
    return await compile(def.condition, ctx);
  } finally {
    ctx._stack = stack;
  }
}

async function consentPredicate(purpose: string, ctx: SqlContext): Promise<SQL> {
  ctx._purposes ??= publishedSingleton(ctx.tx, 'purposes').then((p) => p?.purposes ?? DEFAULT_PURPOSES);
  const p = (await ctx._purposes).find((x) => x.key === purpose);
  if (!p) throw new AppError('invalid_input', `Unknown purpose "${purpose}" in a consent condition. See purposes.list.`);
  // The same rule as consentSet in evaluate.ts (currentConsent and purposeAllowed).
  return purposeAllowedSql(p.basis, consentStatusSql(sql`${schema.profiles.id}`, purpose));
}

async function topicPredicate(topic: string, ctx: SqlContext): Promise<SQL> {
  ctx._purposes ??= publishedSingleton(ctx.tx, 'purposes').then((p) => p?.purposes ?? DEFAULT_PURPOSES);
  const found = findTopic(await ctx._purposes, topic);
  if (!found) throw new AppError('invalid_input', `Unknown topic "${topic}" in a segment condition. See purposes.list.`);
  // The same rule as topicSet in evaluate.ts, including the topic's default.
  return topicSubscribedSql(sql`${schema.profiles.id}`, topic, found.topic.default);
}

async function eventPredicate(c: Extract<SegmentCondition, { event: string }>, ctx: SqlContext): Promise<SQL> {
  const raw = tempName('seg_raw');
  const counts = tempName('seg_ev');
  await ctx.tx.execute(sql.raw(`CREATE TEMP TABLE ${raw} (anonymous_id text, user_id text, n integer) ON COMMIT DROP`));
  for await (const batch of ctx.events.countEventsBatches(ctx.workspaceId, {
    name: c.event,
    where: c.where,
    sinceSeconds: c.within ? durationSeconds(c.within) : undefined,
  }))
    await ctx.tx.execute(sql`INSERT INTO ${sql.raw(raw)}
      SELECT x.a, x.u, x.n FROM jsonb_to_recordset(${JSON.stringify(batch.map((r) => ({ a: r.anonymousId, u: r.userId, n: r.count })))}::jsonb)
        AS x(a text, u text, n integer)`);
  // Identifier counts → profile counts. A row can carry both ids; count it once, for the user id first.
  await ctx.tx.execute(sql`CREATE TEMP TABLE ${sql.raw(counts)} ON COMMIT DROP AS
    SELECT coalesce(u.profile_id, a.profile_id) AS profile_id, sum(r.n)::integer AS n
    FROM ${sql.raw(raw)} r
    LEFT JOIN identifiers u ON r.user_id <> '' AND u.workspace_id = ${ctx.workspaceId} AND u.type = 'user_id' AND u.value = r.user_id
    LEFT JOIN identifiers a ON r.anonymous_id <> '' AND a.workspace_id = ${ctx.workspaceId} AND a.type = 'anonymous_id' AND a.value = r.anonymous_id
    WHERE coalesce(u.profile_id, a.profile_id) IS NOT NULL
    GROUP BY 1`);
  await ctx.tx.execute(sql.raw(`CREATE UNIQUE INDEX ON ${counts} (profile_id); ANALYZE ${counts}`));
  const min = c.count?.gte ?? (c.count?.lte === undefined ? 1 : 0);
  const max = c.count?.lte;
  const n = sql`COALESCE((SELECT e.n FROM ${sql.raw(counts)} e WHERE e.profile_id = ${schema.profiles.id}), 0)`;
  return max === undefined ? sql`(${n} >= ${min})` : sql`(${n} BETWEEN ${min} AND ${max})`;
}

/** Fills a temporary table with the ids of everyone matching; returns its name and size. */
export async function materialize(cond: SegmentCondition, ctx: SqlContext): Promise<{ table: string; size: number }> {
  const predicate = await compile(cond, ctx);
  const table = tempName('seg_members');
  await ctx.tx.execute(sql`CREATE TEMP TABLE ${sql.raw(table)} ON COMMIT DROP AS
    SELECT ${schema.profiles.id} AS profile_id FROM ${schema.profiles} WHERE ${schema.profiles.mergedInto} IS NULL AND ${predicate}`);
  await ctx.tx.execute(sql.raw(`ALTER TABLE ${table} ADD PRIMARY KEY (profile_id); ANALYZE ${table}`));
  const res = await ctx.tx.execute<{ n: number }>(sql.raw(`SELECT count(*)::integer AS n FROM ${table}`));
  return { table, size: Number(res.rows[0].n) };
}
