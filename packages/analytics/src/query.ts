import { complementarySuppression, K, planComplementarySuppression, publishedSingleton } from '@agentic-marketing/artifacts';
import { campaignIdentityMap, identityUnresolvedNote } from '@agentic-marketing/campaigns';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildCampaignQuery, loadCampaignQueryMap } from './campaign';
import {
  buildQuery,
  type CampaignMap,
  type CompiledQuery,
  type ConversionRule,
  type MeasureScope,
  measureScope,
  type NormalizedFilters,
  type Output,
  SOURCE_FILTERS,
} from './compile';
import { DIMENSIONS, type DimensionId, MEASURES, METRIC_CATALOG, type MeasureDef, measureIds, type SourceId } from './registry';

// The read-only metric layer (#75): one typed query over a fixed catalogue. Nothing here accepts
// SQL, a table name, a column name or an expression from the caller. The workspace comes from the
// principal, and ClickHouse's row policy checks it again.

const CACHE_TTL_MS = 60_000;

export { K };
export const MAX_RANGE_DAYS = 400;

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
    campaign: ValueOrList.optional().describe('Campaign ids (cmp_…); resolved to their published sending members'),
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

export type QueryInput = z.infer<typeof queryInput> & {
  /**
   * Internal: restrict journey_events to one published version. Named reports use it so a funnel
   * describes one topology; analytics.query's own input does not accept it.
   */
  journeyVersion?: number;
  /**
   * Internal: return the raw rows without the k floor. Only a named report that applies its own,
   * stricter rule may use it (the journey funnel hides whole subtrees of a hidden step); the raw
   * values never leave that handler. analytics.query's own input does not accept it.
   */
  suppress?: boolean;
};

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
  suppressed: z
    .number()
    .int()
    .describe(
      'Rows and cells whose measures were hidden by the minimum group size, plus any complementary contributors hidden per total; totals that could not be protected are withheld instead and named in notes',
    ),
  k: z.number().int(),
  notes: z.array(z.string()),
});

export const analyticsResult = z.object({
  columns: z.array(analyticsColumn),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  meta: analyticsMeta,
});

export type AnalyticsResult = z.infer<typeof analyticsResult>;

export interface Deps {
  tx: Tx;
  events: EventStore;
  workspaceId: string;
}

/** What the freshness probe must ask, so it describes the same events as the compiled query. */
export interface FreshnessInput {
  source: SourceId;
  from: string;
  to: string;
  filters: NormalizedFilters;
  /** Conversion event names. For events an empty list matches nothing, exactly as in the query. */
  names?: string[];
  scope?: MeasureScope;
  campaignMap?: CampaignMap;
  journeyVersion?: number;
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
    journeyVersion: input.journeyVersion ?? null,
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

export async function freshness(deps: Deps, input: FreshnessInput): Promise<string | null> {
  const { source, from, to, filters, names = [], scope, campaignMap, journeyVersion } = input;
  const table = source === 'events' ? 'events' : source;
  const column = source === 'events' ? 'received_at' : 'at';
  const params: Record<string, unknown> = { ws: deps.workspaceId, from: from.replace('Z', ''), to: to.replace('Z', '') };
  const where = ['workspace_id = {ws:UUID}', `${column} >= {from:DateTime64(3, 'UTC')}`, `${column} <= {to:DateTime64(3, 'UTC')}`];

  // The same constraints the compiled query applies. Without them freshness can name a raw event
  // the result itself cannot count (#589), or an SMS event beside e-mail numbers (#682).
  if (scope?.eventTypes.length) {
    params.types = scope.eventTypes;
    where.push('type IN {types:Array(String)}');
  }
  if (source === 'message_events' && scope?.channels.length) {
    params.channels = scope.channels;
    where.push('channel IN {channels:Array(String)}');
  }
  if (source === 'journey_events' && journeyVersion !== undefined) {
    params.journey_version = journeyVersion;
    where.push('version = {journey_version:UInt32}');
  }
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
    if (key === 'campaign') {
      params.filter_campaign = campaignMap?.memberIds ?? [];
      where.push('journey_id IN {filter_campaign:Array(String)}');
      continue;
    }
    params[`filter_${key}`] = values;
    where.push(`${filterColumn[key]} IN {filter_${key}:Array(String)}`);
  }
  // Always apply the conversion-name set for events: the compiled query does, and an empty list
  // matches nothing, so freshness must return null rather than the newest raw event (#589).
  if (source === 'events') {
    params.names = names;
    where.push('name IN {names:Array(String)}');
  }
  const result = await deps.events.client.query({
    // maxOrNull, not max: over an empty match ClickHouse's max returns 1970-01-01, which would
    // report a fabricated epoch instead of "no events" (#760, the summary relies on null).
    query: `SELECT toString(maxOrNull(${column})) AS m FROM ${table} FINAL WHERE ${where.join(' AND ')}`,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { ...(await deps.events.settingsFor(deps.workspaceId)), max_execution_time: 10, max_result_rows: 1 } as never,
  });
  const rows = await result.json<{ m: string }>();
  const value = rows[0]?.m;
  return value ? `${value.replace(' ', 'T')}Z` : null;
}

export interface SuppressedRows {
  rows: (string | number | null)[][];
  /** Rows and cells whose measures were hidden: those below k, their complements, and revenue cells. */
  suppressed: number;
  /** True when at least one further row or cell was hidden so a single hidden value cannot be derived. */
  complementary: boolean;
  /** Rows whose revenue figures were hidden below k while their counts stayed visible. */
  revenueSuppressed: number;
  /**
   * Totals withheld because exactly one contributor was hidden and no visible contributor with a
   * value was left to hide instead. Named by measure and, for revenue, currency.
   */
  withheld: string[];
}

/**
 * Shapes the compiled rows and applies the k floor. When exactly one contributor to a total is
 * hidden, the smallest visible non-zero contributor in that total is hidden as well (#692), so
 * total minus visible contributors is only the sum of the hidden ones. Contributors are rows
 * grouped by their independent population (the dimension key without currency), so one campaign
 * spread over several currency rows is one contributor, not several.
 *
 * Every total the result exposes beside the rows is protected separately: the people total, each
 * measure, and each per-currency revenue total. When a total has one hidden contributor and no
 * visible non-zero contributor, hiding a complement is impossible and the total is withheld
 * instead; that is the narrow option-A fallback. A hide in one total can make a contributor hidden
 * in another, so the plan repeats until stable. The rows are in the query's deterministic sort
 * order, which decides a tie.
 */
/**
 * Shapes rows without applying the k floor. Only for an internal named report that applies its own
 * rule to the raw counts; the values are never returned directly.
 */
export function rawRows(raw: readonly Record<string, unknown>[], compiled: Pick<CompiledQuery, 'outputs'>): (string | number | null)[][] {
  return raw.map((row) =>
    compiled.outputs.map((out) => {
      const value = row[out.alias];
      if (out.kind === 'dimension') {
        if (value === '' || value === null || value === undefined) return null;
        return typeof value === 'number' ? value : String(value);
      }
      if (value === null || value === undefined) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }),
  );
}

export function suppressRows(
  raw: readonly Record<string, unknown>[],
  compiled: Pick<CompiledQuery, 'outputs' | 'kAlias' | 'revenueKAlias' | 'hasNonTimeDimension'>,
): SuppressedRows {
  const dimensions = compiled.outputs.filter((out): out is Extract<Output, { kind: 'dimension' }> => out.kind === 'dimension');
  const measures = compiled.outputs.filter((out): out is Extract<Output, { kind: 'measure' }> => out.kind === 'measure');
  const currencyAlias = dimensions.find((out) => out.dimension === 'currency')?.alias;
  // The independent population is everything except currency: currency partitions revenue, not people.
  const keyOutputs = dimensions.filter((out) => out.dimension !== 'currency');
  const groupOf = (row: Record<string, unknown>) => Number(row[compiled.kAlias]);
  const numberAt = (row: Record<string, unknown>, alias: string) => {
    const value = row[alias];
    const n = Number(value);
    return value === null || value === undefined || !Number.isFinite(n) ? 0 : n;
  };
  const isMoney = (measure: MeasureDef) => measure.unit === 'currency';

  // Every additive measure, including the bases a requested ratio names but does not list as an
  // output. A ratio is derived from them, never a total of its own.
  const bases = new Map<string, { measure: MeasureDef; alias: string }>();
  for (const out of measures) {
    if (out.measure.kind === 'base') bases.set(out.measure.id, { measure: out.measure, alias: out.alias });
    else
      for (const [id, alias] of [
        [out.measure.numerator, out.numeratorAlias],
        [out.measure.denominator, out.denominatorAlias],
      ] as const) {
        const measure = MEASURES[id];
        if (measure?.kind === 'base' && alias) bases.set(id, { measure, alias });
      }
  }
  const aliasToMeasure = new Map([...bases.values()].map((base) => [base.alias, base.measure.id]));

  interface Contributor {
    id: number;
    rows: number[];
    group: number;
  }
  const contributors: Contributor[] = [];
  const byKey = new Map<string, Contributor>();
  raw.forEach((row, index) => {
    const key = keyOutputs.map((out) => String(row[out.alias] ?? '')).join('\u0000');
    let contributor = byKey.get(key);
    if (!contributor) {
      contributor = { id: contributors.length, rows: [], group: 0 };
      byKey.set(key, contributor);
      contributors.push(contributor);
    }
    contributor.rows.push(index);
    contributor.group = Math.max(contributor.group, groupOf(row));
  });

  const rowHidden = raw.map((row) => {
    if (!compiled.hasNonTimeDimension) return false;
    const group = groupOf(row);
    return !Number.isFinite(group) || group < K;
  });
  // A measure-specific hidden cell. Revenue below its converter floor is a cell, not a row: the
  // recipient and converter counts stay readable (#756).
  const hiddenCells = new Map<number, Set<string>>();
  const hideCell = (index: number, measure: string) => {
    let set = hiddenCells.get(index);
    if (!set) {
      set = new Set();
      hiddenCells.set(index, set);
    }
    set.add(measure);
  };
  const cellIsHidden = (index: number, measure: string) => rowHidden[index] === true || hiddenCells.get(index)?.has(measure) === true;
  // Rows whose revenue is null because their own converters are below k, for the note. A
  // complementary revenue cell is counted in `suppressed` but not here.
  const revenueFloor = new Set<number>();
  if (compiled.revenueKAlias !== undefined)
    raw.forEach((row, index) => {
      if (rowHidden[index]) return;
      const revenueGroup = Number(row[compiled.revenueKAlias!]);
      if (!Number.isFinite(revenueGroup) || revenueGroup <= 0 || revenueGroup >= K) return;
      revenueFloor.add(index);
      for (const base of bases.values()) if (isMoney(base.measure)) hideCell(index, base.measure.id);
    });

  interface TotalDef {
    name: string;
    /** The contributor's rows in this total (one currency partition, or all of them). */
    rows: (contributor: Contributor) => number[];
    /** The contributor's unsuppressed value in this total. */
    value: (contributor: Contributor) => number;
    /** The measure to hide for a cell complement, or null when the people total is at risk. */
    measureId: string | null;
  }
  const totals: TotalDef[] = [
    {
      name: 'group size',
      rows: (contributor) => contributor.rows,
      value: (contributor) => contributor.group,
      measureId: null,
    },
  ];
  for (const base of bases.values()) {
    if (isMoney(base.measure) && currencyAlias) {
      for (const currency of new Set(raw.map((row) => String(row[currencyAlias] ?? '')))) {
        const inCurrency = (contributor: Contributor) =>
          contributor.rows.filter((index) => String(raw[index]![currencyAlias] ?? '') === currency);
        totals.push({
          name: `${base.measure.id}:${currency}`,
          rows: inCurrency,
          value: (contributor) => inCurrency(contributor).reduce((sum, index) => sum + numberAt(raw[index]!, base.alias), 0),
          measureId: base.measure.id,
        });
      }
      continue;
    }
    // A campaign count repeats on every currency row; another source partitions a measure by
    // currency, where the currency rows add up to the measure's total.
    const repeated = base.measure.source === 'campaign';
    totals.push({
      name: base.measure.id,
      rows: (contributor) => contributor.rows,
      value: (contributor) =>
        repeated
          ? Math.max(...contributor.rows.map((index) => numberAt(raw[index]!, base.alias)))
          : contributor.rows.reduce((sum, index) => sum + numberAt(raw[index]!, base.alias), 0),
      measureId: base.measure.id,
    });
  }

  const contributorsFor = (def: TotalDef) =>
    contributors
      .map((contributor) => {
        const rows = def.rows(contributor);
        return {
          id: contributor.id,
          group: contributor.group,
          value: def.value(contributor),
          hidden: rows.some((index) => (def.measureId === null ? rowHidden[index] === true : cellIsHidden(index, def.measureId))),
          present: rows.length > 0,
        };
      })
      .filter((contributor) => contributor.present);

  // Withholding only makes sense when the result is a breakdown under a total; a time series has no
  // total to withhold, and the k floor does not apply to it.
  const plan = compiled.hasNonTimeDimension
    ? planComplementarySuppression({
        totals: totals.map((def) => def.name),
        contributors: (name) => contributorsFor(totals.find((def) => def.name === name)!),
        hide: (name, id) => {
          const def = totals.find((entry) => entry.name === name);
          const contributor = contributors[Number(id)];
          if (!def || !contributor) return false;
          let hid = false;
          for (const index of def.rows(contributor)) {
            if (def.measureId === null) {
              if (rowHidden[index]) continue;
              rowHidden[index] = true;
              hid = true;
              continue;
            }
            if (cellIsHidden(index, def.measureId)) continue;
            hideCell(index, def.measureId);
            hid = true;
          }
          return hid;
        },
      })
    : { withheld: [] as string[], hidden: 0 };

  const ratioHidden = (index: number, out: Extract<Output, { kind: 'measure' }>) => {
    if (out.measure.kind !== 'ratio') return false;
    for (const alias of [out.numeratorAlias, out.denominatorAlias]) {
      if (!alias) continue;
      const measure = aliasToMeasure.get(alias);
      if (measure && cellIsHidden(index, measure)) return true;
    }
    return false;
  };

  const rows = raw.map((row, index) =>
    compiled.outputs.map((out) => {
      const value = row[out.alias];
      if (out.kind === 'dimension') {
        if (value === '' || value === null || value === undefined) return null;
        return typeof value === 'number' ? value : String(value);
      }
      if (rowHidden[index] || cellIsHidden(index, out.measure.id) || ratioHidden(index, out)) return null;
      if (value === null || value === undefined) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }),
  );

  let cellSuppressed = 0;
  for (const [index] of hiddenCells) {
    if (rowHidden[index]) continue;
    cellSuppressed += 1;
  }
  return {
    rows,
    suppressed: rowHidden.filter(Boolean).length + cellSuppressed,
    complementary: plan.hidden > 0,
    revenueSuppressed: [...revenueFloor].filter((index) => !rowHidden[index]).length,
    withheld: plan.withheld,
  };
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
  let complementary = false;
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
    const hidden = shaped.map((r) => r.n < K);
    const extra = complementarySuppression(shaped.map((r, i) => ({ group: r.n, hidden: hidden[i]! })));
    if (extra !== null) hidden[extra] = true;
    complementary = extra !== null;
    suppressed = hidden.filter(Boolean).length;
    rowsOut = shaped.map((r, i) => [r.segment, hidden[i] ? null : r.n]);
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
      notes: [
        'segment.members is the current membership size; from and to do not change it.',
        ...(complementary ? ['One further segment row was suppressed so a single group below k cannot be derived from the total.'] : []),
      ],
    },
  };
}

async function execute(deps: Deps, input: QueryInput, measures: MeasureDef[], dimensions: DimensionId[], filters: NormalizedFilters) {
  const source = measures[0].source;
  if (source === 'segment_memberships') return segmentQuery(deps, input, filters);

  const timeZone = await workspaceTimeZone(deps.tx, deps.workspaceId);
  const campaignSource = source === 'campaign';
  const conversion =
    source === 'events' || campaignSource ? await conversionInput(deps.tx, filters) : { rules: [], names: [], hasMap: false };

  // The campaign mapping is resolved in Postgres and travels to ClickHouse as arrays. For the
  // per-channel measures it is only needed for the campaign dimension or filter.
  const needsCampaignMap = campaignSource || dimensions.includes('campaign') || !!filters.campaign?.length;
  const queryMap = needsCampaignMap
    ? await loadCampaignQueryMap(deps.tx, filters.campaign, campaignSource ? conversion.rules.map((r) => r.event) : [])
    : undefined;
  // Campaign conversions resolve identity the same way the holdout card does (#590). The map's
  // scope is the union of the campaign's sent recipients and its holdout assignments, so the two
  // surfaces cannot fall on different sides of the bound; above it both omit the map and the note
  // below says the result is not identity-resolved.
  const identity = campaignSource
    ? await campaignIdentityMap(deps, {
        campaignIds: queryMap?.scopes.map((scope) => scope.id) ?? [],
        memberIds: queryMap?.map.memberIds ?? [],
        from: input.from,
        to: input.to,
      })
    : undefined;

  const compiled: CompiledQuery = campaignSource
    ? buildCampaignQuery({
        workspaceId: deps.workspaceId,
        measures,
        dimensions,
        from: input.from,
        to: input.to,
        timeZone,
        filters,
        limit: input.limit,
        order: input.order,
        conversionRules: conversion.rules,
        queryMap: queryMap!,
        identity,
      })
    : buildQuery({
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
        campaignMap: queryMap?.map,
        journeyVersion: input.journeyVersion,
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

  const shaped =
    input.suppress === false
      ? { rows: rawRows(raw, compiled), suppressed: 0, complementary: false, revenueSuppressed: 0, withheld: [] as string[] }
      : suppressRows(raw, compiled);
  const rows = shaped.rows;
  const { suppressed, revenueSuppressed } = shaped;

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
  if (revenueSuppressed) notes.push(`Currency rows with fewer than k=${K} converters have their revenue suppressed.`);
  if (source === 'events' && !conversion.names.length)
    notes.push('No conversion map is published and no name filter was given, so there are no conversion events to count.');
  if (source === 'events' && !conversion.hasMap && conversion.names.length)
    notes.push('No conversion map is published; only the requested event names are counted.');
  if (campaignSource)
    notes.push(
      'Campaign conversions are people who got a campaign message and converted within the goal’s attribution window of their first campaign message (first touch).',
    );
  if (campaignSource && identity?.overLimit) notes.push(identityUnresolvedNote(identity.limit));
  if (suppressed) notes.push(`Groups smaller than k=${K} have their measures suppressed.`);
  if (shaped.complementary) notes.push('One further group was suppressed so a single group below k cannot be derived from the total.');
  if (shaped.withheld.length)
    notes.push(
      `A total was withheld because it had one hidden contributor and no visible group with a value to hide in its place: ${shaped.withheld.join(', ')}.`,
    );

  return {
    columns: compiled.columns,
    rows,
    meta: {
      timeZone,
      currency: currencies.size === 1 && !currencies.has('UNKNOWN') ? [...currencies][0] : null,
      from: input.from,
      to: input.to,
      freshness: await freshness(deps, {
        source: campaignSource ? 'message_events' : source,
        from: input.from,
        to: input.to,
        filters,
        names: conversion.names,
        scope: measureScope(measures),
        campaignMap: queryMap?.map,
        journeyVersion: input.journeyVersion,
      }),
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
    'Read a fixed catalogue of marketing measures, broken down by up to three dimensions. Measures have stable ids (email.sent, email.delivered, email.click_rate, journey.entered, conversions, revenue, segment.members, …); ratios are computed from their base measures after aggregation, never averaged. The workspace time zone decides day, week and month boundaries. Breakdowns by anything other than a time dimension hide rows with fewer than k=5 people behind their counts and report how many were suppressed in meta.suppressed. Every total the result exposes beside its rows is protected per total: the people total, each measure and each per-currency revenue total hide their smallest visible non-zero contributor when exactly one contributor is hidden. A total with one hidden contributor and no visible non-zero contributor to hide instead is withheld and named in the notes. A campaign revenue row is keyed on the people who converted in its currency, so its revenue and revenue per recipient are null below k=5 even when the campaign reached enough people, and it is counted in meta.suppressed. There is no SQL, table or expression input, and the workspace always comes from the caller. Results are cached for 60 seconds; each query is limited to 10 seconds and at most 5000 rows.',
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
        source: z.enum(['message_events', 'journey_events', 'events', 'segment_memberships', 'campaign']),
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
