import { publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildQuery, type ConversionRule, type NormalizedFilters, SOURCE_FILTERS } from './compile';
import { DIMENSIONS, type DimensionId, MEASURES, METRIC_CATALOG, type MeasureDef, measureIds, type SourceId } from './registry';

// The read-only metric layer (#75): one typed query over a fixed catalogue. Nothing here accepts
// SQL, a table name, a column name or an expression from the caller. The workspace comes from the
// principal, and ClickHouse's row policy checks it again.

const K = 5;
const CACHE_TTL_MS = 60_000;
const MAX_RANGE_DAYS = 400;

const ValueOrList = z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(100)]);

export const filterInput = z
  .object({
    template: ValueOrList.optional(),
    broadcast: ValueOrList.optional(),
    journey: ValueOrList.optional(),
    channel: ValueOrList.optional(),
    purpose: ValueOrList.optional(),
    variant: ValueOrList.optional(),
    name: ValueOrList.optional().describe('Conversion event names, instead of or in addition to the conversion map'),
    segment: ValueOrList.optional(),
  })
  .strict();

export const queryInput = z.object({
  measures: z.array(z.string().min(1).max(100)).min(1).max(10),
  dimensions: z.array(z.string().min(1).max(40)).max(3).default([]),
  from: isoDateTime('from'),
  to: isoDateTime('to'),
  filters: filterInput.optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
  order: z
    .object({
      by: z.string().min(1).max(100).describe('A measure id or a requested dimension, e.g. email.sent or day'),
      dir: z.enum(['asc', 'desc']),
    })
    .optional(),
});

export type QueryInput = z.infer<typeof queryInput>;

export const analyticsColumn = z.object({
  name: z.string(),
  kind: z.enum(['dimension', 'measure']),
  unit: z.enum(['count', 'ratio', 'currency']).optional(),
});

export const analyticsMeta = z.object({
  timeZone: z.string(),
  currency: z.string().nullable().describe('The single currency in the result, or null when there are none or several'),
  from: z.string(),
  to: z.string(),
  freshness: z.string().nullable().describe('Newest event in the range, as an ISO date-time'),
  suppressed: z.number().int().describe('Rows whose measures were hidden by the minimum group size'),
  k: z.number().int(),
  notes: z.array(z.string()),
});

export const analyticsResult = z.object({
  columns: z.array(analyticsColumn),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  meta: analyticsMeta,
});

export type AnalyticsResult = z.infer<typeof analyticsResult>;

interface Deps {
  tx: Tx;
  events: EventStore;
  workspaceId: string;
}

interface CacheEntry {
  expires: number;
  value: AnalyticsResult;
}

const cache = new Map<string, CacheEntry>();

/** Clears the 60-second query cache. Tests use it after inserting more events. */
export function clearAnalyticsCache() {
  cache.clear();
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function normalizeFilters(input: QueryInput['filters']): NormalizedFilters {
  if (!input) return {};
  const out: NormalizedFilters = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    const values = [...new Set((Array.isArray(raw) ? raw : [raw]).map((v) => v.trim()).filter(Boolean))];
    if (!values.length) throw new AppError('invalid_input', `The "${key}" filter needs at least one value.`);
    out[key as keyof NormalizedFilters] = values;
  }
  return out;
}

function validate(input: QueryInput): { measures: MeasureDef[]; dimensions: DimensionId[]; filters: NormalizedFilters } {
  const chosen: MeasureDef[] = [];
  for (const id of input.measures) {
    const measure = MEASURES[id];
    if (!measure) throw new AppError('invalid_input', `Unknown measure "${id}". Available measures: ${measureIds().join(', ')}.`);
    if (!chosen.some((m) => m.id === id)) chosen.push(measure);
  }

  const dimensions: DimensionId[] = [];
  for (const id of input.dimensions) {
    if (!(id in DIMENSIONS))
      throw new AppError('invalid_input', `Unknown dimension "${id}". Available dimensions: ${Object.keys(DIMENSIONS).join(', ')}.`);
    if (!dimensions.includes(id as DimensionId)) dimensions.push(id as DimensionId);
  }

  const source = chosen[0].source;
  const mixed = chosen.filter((m) => m.source !== source);
  if (mixed.length)
    throw new AppError(
      'invalid_input',
      `These measures read different sources (${source} and ${mixed[0].source}); query one source at a time.`,
    );

  for (const measure of chosen)
    for (const dimension of dimensions) {
      if (!measure.dimensions.includes(dimension))
        throw new AppError(
          'invalid_input',
          `${measure.id} cannot be broken down by "${dimension}". It supports: ${measure.dimensions.join(', ')}.`,
        );
    }

  const filters = normalizeFilters(input.filters);
  const allowed = SOURCE_FILTERS[source] as string[];
  for (const key of Object.keys(filters))
    if (!allowed.includes(key))
      throw new AppError(
        'invalid_input',
        `The "${key}" filter does not apply to ${source}. It supports: ${allowed.length ? allowed.join(', ') : 'no filters'}.`,
      );

  if (input.order && !input.measures.includes(input.order.by) && !input.dimensions.includes(input.order.by))
    throw new AppError(
      'invalid_input',
      `order.by must be one of the query's measures or dimensions: ${[...input.measures, ...input.dimensions].join(', ')}.`,
    );

  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (!(from < to)) throw new AppError('invalid_input', 'from must be before to.');
  if (to - from > MAX_RANGE_DAYS * 86_400_000) throw new AppError('invalid_input', `The time range may be at most ${MAX_RANGE_DAYS} days.`);

  return { measures: chosen, dimensions, filters };
}

async function workspaceTimeZone(tx: Tx, workspaceId: string): Promise<string> {
  const [w] = await tx
    .select({ timeZone: schema.workspaces.timeZone })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  return w?.timeZone ?? 'UTC';
}

function cacheKey(workspaceId: string, input: QueryInput, filters: NormalizedFilters): string {
  const sortedFilters = Object.fromEntries(
    Object.entries(filters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()]),
  );
  return JSON.stringify({
    workspaceId,
    measures: input.measures,
    dimensions: input.dimensions,
    from: input.from,
    to: input.to,
    filters: sortedFilters,
    limit: input.limit,
    order: input.order ?? null,
  });
}

async function conversionInput(tx: Tx, filters: NormalizedFilters): Promise<{ rules: ConversionRule[]; names: string[]; hasMap: boolean }> {
  const map = await publishedSingleton(tx, 'conversion_map');
  const rules: ConversionRule[] = (map?.rules ?? []).map((r) => ({
    event: r.event,
    ...(r.value ? { value: r.value } : {}),
    ...(r.currency ? { currency: r.currency } : {}),
    ...(r.currencyProperty ? { currencyProperty: r.currencyProperty } : {}),
  }));
  const mapNames = [...new Set(rules.map((r) => r.event))];
  return { rules, names: filters.name?.length ? filters.name : mapNames, hasMap: !!map };
}

async function freshness(
  deps: Deps,
  source: SourceId,
  from: string,
  to: string,
  filters: NormalizedFilters,
  names: string[],
): Promise<string | null> {
  const table = source === 'events' ? 'events' : source;
  const column = source === 'events' ? 'received_at' : 'at';
  const params: Record<string, unknown> = { ws: deps.workspaceId, from: from.replace('Z', ''), to: to.replace('Z', '') };
  const where = ['workspace_id = {ws:UUID}', `${column} >= {from:DateTime64(3, 'UTC')}`, `${column} <= {to:DateTime64(3, 'UTC')}`];
  const filterColumn: Partial<Record<keyof NormalizedFilters, string>> = {
    template: 'template_id',
    broadcast: 'journey_id',
    journey: 'journey_id',
    channel: 'channel',
    purpose: 'purpose',
    variant: 'variant',
    name: 'name',
    segment: 'segment_id',
  };
  for (const key of SOURCE_FILTERS[source]) {
    const values = filters[key];
    if (!values?.length) continue;
    params[`filter_${key}`] = values;
    where.push(`${filterColumn[key]} IN {filter_${key}:Array(String)}`);
  }
  if (source === 'events' && names.length) {
    params.names = names;
    where.push('name IN {names:Array(String)}');
  }
  const result = await deps.events.client.query({
    query: `SELECT toString(max(${column})) AS m FROM ${table} FINAL WHERE ${where.join(' AND ')}`,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { ...(await deps.events.settingsFor(deps.workspaceId)), max_execution_time: 10, max_result_rows: 1 } as never,
  });
  const rows = await result.json<{ m: string }>();
  const value = rows[0]?.m;
  return value ? `${value.replace(' ', 'T')}Z` : null;
}

async function segmentQuery(deps: Deps, input: QueryInput, filters: NormalizedFilters): Promise<AnalyticsResult> {
  const timeZone = await workspaceTimeZone(deps.tx, deps.workspaceId);
  const dimensions = input.dimensions as DimensionId[];
  const bySegment = dimensions.includes('segment');
  const measure = MEASURES['segment.members'];

  const where = and(
    eq(schema.segmentMemberships.workspaceId, deps.workspaceId),
    filters.segment?.length ? inArray(schema.segmentMemberships.segmentId, filters.segment) : undefined,
  );

  let rowsOut: (string | number | null)[][] = [];
  let suppressed = 0;
  if (bySegment) {
    const rows = await deps.tx
      .select({ segment: schema.segmentMemberships.segmentId, n: sql<number>`count(*)::int` })
      .from(schema.segmentMemberships)
      .where(where)
      .groupBy(schema.segmentMemberships.segmentId);
    let shaped = rows.map((r) => ({ segment: r.segment, n: Number(r.n) }));
    if (input.order?.by === 'segment')
      shaped.sort((a, b) => (input.order?.dir === 'desc' ? b.segment.localeCompare(a.segment) : a.segment.localeCompare(b.segment)));
    else if (input.order?.by === 'segment.members') shaped.sort((a, b) => (input.order?.dir === 'desc' ? b.n - a.n : a.n - b.n));
    else shaped.sort((a, b) => a.segment.localeCompare(b.segment));
    shaped = shaped.slice(0, input.limit);
    rowsOut = shaped.map((r) => {
      const hide = r.n < K;
      if (hide) suppressed++;
      return [r.segment, hide ? null : r.n];
    });
  } else {
    const [row] = await deps.tx.select({ n: sql<number>`count(*)::int` }).from(schema.segmentMemberships).where(where);
    rowsOut = [[Number(row?.n ?? 0)]];
  }

  return {
    columns: [
      ...dimensions.map((d) => ({ name: d, kind: 'dimension' as const })),
      { name: measure.id, kind: 'measure' as const, unit: measure.unit },
    ],
    rows: rowsOut,
    meta: {
      timeZone,
      currency: null,
      from: input.from,
      to: input.to,
      freshness: new Date().toISOString(),
      suppressed,
      k: K,
      notes: ['segment.members is the current membership size; from and to do not change it.'],
    },
  };
}

async function execute(deps: Deps, input: QueryInput, measures: MeasureDef[], dimensions: DimensionId[], filters: NormalizedFilters) {
  const source = measures[0].source;
  if (source === 'segment_memberships') return segmentQuery(deps, input, filters);

  const timeZone = await workspaceTimeZone(deps.tx, deps.workspaceId);
  const conversion = source === 'events' ? await conversionInput(deps.tx, filters) : { rules: [], names: [], hasMap: false };
  const compiled = buildQuery({
    workspaceId: deps.workspaceId,
    measures,
    dimensions,
    source,
    from: input.from,
    to: input.to,
    timeZone,
    filters,
    limit: input.limit,
    order: input.order,
    conversionRules: conversion.rules,
    conversionNames: conversion.names,
  });

  const started = Date.now();
  const result = await deps.events.client.query({
    query: compiled.sql,
    query_params: compiled.params,
    format: 'JSONEachRow',
    clickhouse_settings: {
      ...(await deps.events.settingsFor(deps.workspaceId)),
      max_execution_time: 10,
      max_result_rows: input.limit,
      result_overflow_mode: 'break',
    } as never,
  });
  const raw = await result.json<Record<string, unknown>>();
  const durationMs = Date.now() - started;
  const summary = result as unknown as {
    summary?: { read_rows?: string | number };
    response_headers?: Record<string, string>;
  };
  let rowsRead = Number(summary.summary?.read_rows ?? Number.NaN);
  if (!Number.isFinite(rowsRead)) {
    try {
      const header = summary.response_headers?.['x-clickhouse-summary'];
      rowsRead = header ? Number(JSON.parse(header).read_rows) : Number.NaN;
    } catch {
      rowsRead = Number.NaN;
    }
  }
  logger.info(
    {
      workspaceId: deps.workspaceId,
      source,
      measures: measures.map((m) => m.id),
      dimensions,
      rows: raw.length,
      rowsRead: Number.isFinite(rowsRead) ? rowsRead : raw.length,
      durationMs,
    },
    'analytics query',
  );

  let suppressed = 0;
  const rows = raw.map((row) => {
    const k = Number(row[compiled.kAlias]);
    const hide = compiled.hasNonTimeDimension && (!Number.isFinite(k) || k < K);
    if (hide) suppressed++;
    return compiled.outputs.map((out) => {
      const value = row[out.alias];
      if (out.kind === 'dimension') {
        if (value === '' || value === null || value === undefined) return null;
        return typeof value === 'number' ? value : String(value);
      }
      if (hide) return null;
      if (value === null || value === undefined) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    });
  });

  const currencyIndex = compiled.outputs.findIndex((o) => o.kind === 'dimension' && o.dimension === 'currency');
  const currencies = new Set(
    (currencyIndex >= 0 ? rows.map((r) => r[currencyIndex]) : [])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toUpperCase()),
  );

  const notes: string[] = [];
  if (measures.some((m) => m.id === 'email.opened' || m.id === 'email.open_rate'))
    notes.push('Opens are counted only where tracking is enabled.');
  if (measures.some((m) => m.kind === 'ratio'))
    notes.push('Rates are computed from aggregated base measures, not by averaging other rates.');
  if (compiled.revenue)
    notes.push('Revenue is grouped by the currency on the conversion event; different currencies are never added together.');
  if (source === 'events' && !conversion.names.length)
    notes.push('No conversion map is published and no name filter was given, so there are no conversion events to count.');
  if (source === 'events' && !conversion.hasMap && conversion.names.length)
    notes.push('No conversion map is published; only the requested event names are counted.');
  if (suppressed) notes.push(`Groups smaller than k=${K} have their measures suppressed.`);

  return {
    columns: compiled.columns,
    rows,
    meta: {
      timeZone,
      currency: currencies.size === 1 && !currencies.has('UNKNOWN') ? [...currencies][0] : null,
      from: input.from,
      to: input.to,
      freshness: await freshness(deps, source, input.from, input.to, filters, conversion.names),
      suppressed,
      k: K,
      notes,
    },
  } satisfies AnalyticsResult;
}

/** Validates, caches for 60 seconds, and runs one query. Tenant scope comes from deps only. */
export async function runAnalyticsQuery(deps: Deps, input: QueryInput): Promise<AnalyticsResult> {
  const { measures, dimensions, filters } = validate(input);
  const key = cacheKey(deps.workspaceId, input, filters);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) {
    logger.debug({ workspaceId: deps.workspaceId, measures: input.measures }, 'analytics query cache hit');
    return clone(hit.value);
  }
  const value = await execute(deps, input, measures, dimensions, filters);
  cache.set(key, { expires: now + CACHE_TTL_MS, value });
  // Keep the map small in a long-running process; the TTL is the point, not an unbounded store.
  if (cache.size > 500) for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  return clone(value);
}

export const analyticsQuery = defineCommand({
  name: 'analytics.query',
  title: 'Query marketing metrics',
  description:
    'Read a fixed catalogue of marketing measures, broken down by up to three dimensions. Measures have stable ids (email.sent, email.delivered, email.click_rate, journey.entered, conversions, revenue, segment.members, …); ratios are computed from their base measures after aggregation, never averaged. The workspace time zone decides day, week and month boundaries. Breakdowns by anything other than a time dimension hide rows with fewer than k=5 people behind their counts and report how many were suppressed in meta.suppressed; totals are never suppressed. There is no SQL, table or expression input, and the workspace always comes from the caller. Results are cached for 60 seconds; each query is limited to 10 seconds and at most 5000 rows.',
  input: queryInput,
  output: analyticsResult,
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) =>
    runAnalyticsQuery({ tx: ctx.tx, events: ctx.services.events, workspaceId: ctx.principal.workspaceId }, input),
});

export const analyticsMetricsList = defineCommand({
  name: 'analytics.metrics.list',
  title: 'Metric catalogue',
  description:
    'The measures and dimensions analytics.query accepts, with each measure’s unit, aggregation, source and allowed dimensions. Use it before building a query or a picker.',
  input: z.object({}),
  output: z.object({
    measures: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        unit: z.enum(['count', 'ratio', 'currency']),
        aggregation: z.string(),
        source: z.enum(['message_events', 'journey_events', 'events', 'segment_memberships']),
        dimensions: z.array(z.string()),
        defaultGrain: z.string().nullable(),
        kind: z.enum(['base', 'ratio']),
        numerator: z.string().optional(),
        denominator: z.string().optional(),
      }),
    ),
    dimensions: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        time: z.boolean(),
        sources: z.array(z.string()),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async () => METRIC_CATALOG,
});
