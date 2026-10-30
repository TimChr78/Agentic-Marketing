import type { DimensionId, MeasureDef, SourceId, Unit } from './registry';
import { MEASURES } from './registry';

// The SQL compiler. Callers supply measure ids, dimension ids and filter values; everything else
// (tables, columns, expressions, aliases) comes from the registry and the conversion map. Values
// travel as `{name:Type}` parameters, never by string concatenation.

export interface ConversionRule {
  event: string;
  value?: string;
  currency?: string;
  currencyProperty?: string;
}

export interface NormalizedFilters {
  template?: string[];
  broadcast?: string[];
  journey?: string[];
  channel?: string[];
  purpose?: string[];
  variant?: string[];
  name?: string[];
  segment?: string[];
  campaign?: string[];
}

/**
 * The published campaigns' sending members, resolved in Postgres and passed to ClickHouse as
 * arrays. `memberCampaignIds[i]` is the campaign that owns `memberIds[i]`; both are bounded by
 * the campaign editor (50 campaigns × 50 members).
 */
export interface CampaignMap {
  memberIds: string[];
  memberCampaignIds: string[];
}

export interface BuildInput {
  workspaceId: string;
  measures: MeasureDef[];
  dimensions: DimensionId[];
  source: SourceId;
  from: string;
  to: string;
  timeZone: string;
  filters: NormalizedFilters;
  limit: number;
  order?: { by: string; dir: 'asc' | 'desc' };
  conversionRules: ConversionRule[];
  conversionNames: string[];
  campaignMap?: CampaignMap;
}

export interface Column {
  name: string;
  kind: 'dimension' | 'measure';
  unit?: Unit;
}

export type Output =
  | { kind: 'dimension'; dimension: DimensionId | 'currency'; alias: string }
  | {
      kind: 'measure';
      measure: MeasureDef;
      alias: string;
      numeratorAlias?: string;
      denominatorAlias?: string;
    };

export interface CompiledQuery {
  sql: string;
  params: Record<string, unknown>;
  columns: Column[];
  outputs: Output[];
  kAlias: string;
  hasNonTimeDimension: boolean;
  revenue: boolean;
}

const SOURCE_TABLE: Record<SourceId, string> = {
  message_events: 'message_events',
  journey_events: 'journey_events',
  events: 'events',
  segment_memberships: 'segment_memberships',
  // Campaign measures need a join between message_events and events; campaign.ts compiles them.
  campaign: '',
};

const TIME_COLUMN: Record<SourceId, string> = {
  message_events: 'at',
  journey_events: 'at',
  events: 'timestamp',
  segment_memberships: '',
  campaign: '',
};

const DIMENSION_SQL: Record<SourceId, Partial<Record<DimensionId, string>>> = {
  message_events: {
    day: "formatDateTime(toStartOfDay(at, {tz:String}), '%Y-%m-%d')",
    week: "formatDateTime(toStartOfWeek(at, 1, {tz:String}), '%Y-%m-%d')",
    month: "formatDateTime(toStartOfMonth(at, {tz:String}), '%Y-%m-%d')",
    channel: 'channel',
    template: 'template_id',
    broadcast: "if(startsWith(journey_id, 'bct_'), journey_id, '')",
    journey: "if(startsWith(journey_id, 'jrn_'), journey_id, '')",
    purpose: 'purpose',
    variant: 'variant',
    message_type:
      "multiIf(startsWith(journey_id, 'bct_'), 'broadcast', startsWith(journey_id, 'jrn_'), 'journey', journey_id = '', 'transactional', 'other')",
    // The campaign map is a pair of parameter arrays; indexOf is 1-based and 0 means "not a
    // campaign member", which arrayElement turns into the empty string (null in the result).
    campaign: 'arrayElement({campaign_map_ids:Array(String)}, indexOf({campaign_map_members:Array(String)}, journey_id))',
  },
  journey_events: {
    day: "formatDateTime(toStartOfDay(at, {tz:String}), '%Y-%m-%d')",
    week: "formatDateTime(toStartOfWeek(at, 1, {tz:String}), '%Y-%m-%d')",
    month: "formatDateTime(toStartOfMonth(at, {tz:String}), '%Y-%m-%d')",
    journey: 'journey_id',
    journey_step: 'node',
    campaign: 'arrayElement({campaign_map_ids:Array(String)}, indexOf({campaign_map_members:Array(String)}, journey_id))',
  },
  events: {
    day: "formatDateTime(toStartOfDay(timestamp, {tz:String}), '%Y-%m-%d')",
    week: "formatDateTime(toStartOfWeek(timestamp, 1, {tz:String}), '%Y-%m-%d')",
    month: "formatDateTime(toStartOfMonth(timestamp, {tz:String}), '%Y-%m-%d')",
  },
  segment_memberships: {
    segment: 'segment_id',
  },
  campaign: {},
};

/** Aggregate sort keys for dimensions where the label alone is not chronological. */
const DIMENSION_SORT: Partial<Record<SourceId, Partial<Record<DimensionId, string>>>> = {
  message_events: { broadcast: 'min(at)' },
  journey_events: { journey_step: 'min(seq)' },
};

const FILTER_SQL: Record<SourceId, Partial<Record<keyof NormalizedFilters, string>>> = {
  message_events: {
    template: 'template_id IN {filter_template:Array(String)}',
    broadcast: 'journey_id IN {filter_broadcast:Array(String)}',
    journey: 'journey_id IN {filter_journey:Array(String)}',
    channel: 'channel IN {filter_channel:Array(String)}',
    purpose: 'purpose IN {filter_purpose:Array(String)}',
    variant: 'variant IN {filter_variant:Array(String)}',
    campaign: 'journey_id IN {filter_campaign:Array(String)}',
  },
  journey_events: {
    journey: 'journey_id IN {filter_journey:Array(String)}',
    campaign: 'journey_id IN {filter_campaign:Array(String)}',
  },
  events: { name: 'name IN {filter_name:Array(String)}' },
  segment_memberships: { segment: 'segment_id IN {filter_segment:Array(String)}' },
  campaign: {},
};

export const SOURCE_FILTERS: Record<SourceId, (keyof NormalizedFilters)[]> = {
  message_events: ['template', 'broadcast', 'journey', 'channel', 'purpose', 'variant', 'campaign'],
  journey_events: ['journey', 'campaign'],
  events: ['name'],
  segment_memberships: ['segment'],
  campaign: ['campaign'],
};

export function dimensionExpression(source: SourceId, dimension: DimensionId): string {
  return DIMENSION_SQL[source][dimension] ?? '';
}

const alias = (prefix: string, id: string) => `${prefix}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

function baseExpression(base: MeasureDef, valueExpression: string): string {
  if (base.kind !== 'base') throw new Error(`ratio ${base.id} has no base expression`);
  const types = (base.eventTypes ?? []).map((t) => `type = '${t}'`).join(' OR ');
  switch (base.counting) {
    case 'profiles':
      return `uniqExactIf(profile_id, profile_id != '' AND (${types}))`;
    case 'participants':
      return `uniqExactIf(participant_id, (${types}))`;
    case 'events':
      return 'uniqExact(event_id)';
    // A failure or other row-shaped event has no event id; count matching rows. The event types
    // are part of the condition so this stays correct when a query mixes measures.
    case 'rows':
      return types ? `countIf(${types})` : 'count()';
    case 'revenue':
      return `sum(${valueExpression})`;
    case 'segment_members':
      throw new Error('segment membership is read from Postgres, not ClickHouse');
    case 'campaign_recipients':
    case 'campaign_converters':
    case 'campaign_revenue':
      throw new Error(`${base.id} is compiled by the campaign query builder`);
  }
}

function kExpression(source: SourceId): string {
  if (source === 'events') return "uniqExact(if(anonymous_id != '', anonymous_id, if(user_id != '', concat('u:', user_id), event_id)))";
  return "uniqExactIf(profile_id, profile_id != '')";
}

/** Value and currency expressions for the conversion map's rules, with their parameters. */
export function revenueExpressions(rules: ConversionRule[], params: Record<string, unknown>): { value: string; currency: string } {
  // One rule per event: a conversion event must not be counted twice when the map sends it to
  // several ad platforms.
  const byEvent = new Map<string, ConversionRule>();
  for (const rule of rules) if (!byEvent.has(rule.event)) byEvent.set(rule.event, rule);
  const list = [...byEvent.values()];

  const branches = list.map((rule, i) => {
    params[`conv${i}`] = rule.event;
    const path = (rule.value ?? '').split('.').filter(Boolean);
    path.forEach((key, j) => {
      params[`conv${i}_key${j}`] = key;
    });
    const value = path.length
      ? `JSONExtractFloat(toString(properties), ${path.map((_, j) => `{conv${i}_key${j}:String}`).join(', ')})`
      : 'toFloat64(0)';
    let currency = "'UNKNOWN'";
    if (rule.currency) {
      params[`conv${i}_currency`] = rule.currency;
      currency = `{conv${i}_currency:String}`;
    } else if (rule.currencyProperty) {
      const cp = rule.currencyProperty.split('.').filter(Boolean);
      cp.forEach((key, j) => {
        params[`conv${i}_cur${j}`] = key;
      });
      const raw = `upper(JSONExtractString(toString(properties), ${cp.map((_, j) => `{conv${i}_cur${j}:String}`).join(', ')}))`;
      currency = `if(${raw} = '', 'UNKNOWN', ${raw})`;
    }
    return { event: `{conv${i}:String}`, value, currency };
  });

  return {
    value: branches.length ? `multiIf(${branches.map((b) => `name = ${b.event}, ${b.value}`).join(', ')}, toFloat64(0))` : 'toFloat64(0)',
    currency: branches.length ? `multiIf(${branches.map((b) => `name = ${b.event}, ${b.currency}`).join(', ')}, 'UNKNOWN')` : "'UNKNOWN'",
  };
}

export function buildQuery(input: BuildInput): CompiledQuery {
  const { source, measures, dimensions } = input;
  const params: Record<string, unknown> = {
    ws: input.workspaceId,
    tz: input.timeZone,
    from: input.from.replace('Z', ''),
    to: input.to.replace('Z', ''),
    limit: input.limit,
  };
  const table = SOURCE_TABLE[source];
  const timeColumn = TIME_COLUMN[source];
  const revenue = measures.some((m) => m.id === 'revenue');
  const conversion = revenueExpressions(input.conversionRules, params);

  // Campaign ids never travel as SQL text: the map is a pair of bounded Array(String) parameters.
  if (dimensions.includes('campaign') || input.filters.campaign?.length) {
    params.campaign_map_members = input.campaignMap?.memberIds ?? [];
    params.campaign_map_ids = input.campaignMap?.memberCampaignIds ?? [];
  }

  // Base measures are aggregated in the inner query, whether or not the caller asked for them:
  // ratios need their numerator and denominator after aggregation, never an average of ratios.
  const baseById = new Map<string, MeasureDef>();
  for (const m of measures) {
    if (m.kind === 'base') baseById.set(m.id, m);
    else {
      for (const id of [m.numerator, m.denominator]) {
        const base = MEASURES[id];
        if (base?.kind !== 'base') throw new Error(`ratio ${m.id} refers to missing base ${id}`);
        baseById.set(id, base);
      }
    }
  }

  const dimExpressions = dimensions.map((d) => dimensionExpression(source, d));
  const dimAliases = dimensions.map((d) => alias('dim', d));
  const baseAliases = new Map<string, string>();
  for (const [id] of baseById) baseAliases.set(id, alias('base', id));

  const inner: string[] = [
    ...dimExpressions.map((e, i) => `${e} AS ${dimAliases[i]}`),
    ...[...baseById.entries()].map(([id, base]) => `${baseExpression(base, conversion.value)} AS ${baseAliases.get(id)}`),
    `${kExpression(source)} AS k_group`,
  ];
  const groupBy = [...dimExpressions];

  let currencyAlias: string | undefined;
  if (revenue) {
    currencyAlias = 'dim_currency';
    inner.push(`${conversion.currency} AS ${currencyAlias}`);
    groupBy.push(conversion.currency);
  }

  // A chronological order key for broadcast and journey_step needs an aggregate that is not a
  // visible column; add it to the inner query and sort on it outside.
  // Also without an explicit order: a broadcast or journey_step breakdown defaults to it.
  const order = input.order;
  const orderBy = order?.by ?? dimensions[0];
  const orderDimension = orderBy && dimensions.includes(orderBy as DimensionId) ? (orderBy as DimensionId) : undefined;
  const orderSort = orderDimension ? DIMENSION_SORT[source]?.[orderDimension] : undefined;
  let sortAlias: string | undefined;
  if (orderSort) {
    sortAlias = 'sort_key';
    inner.push(`${orderSort} AS ${sortAlias}`);
  }

  const where: string[] = [
    'workspace_id = {ws:UUID}',
    `${timeColumn} >= {from:DateTime64(3, 'UTC')}`,
    `${timeColumn} <= {to:DateTime64(3, 'UTC')}`,
  ];

  // Only scan the event types the requested measures actually count. This also keeps journey
  // nodes without a step event (the trigger, the goal) out of a step breakdown.
  const eventTypes = [...new Set([...baseById.values()].flatMap((base) => (base.kind === 'base' ? (base.eventTypes ?? []) : [])))];
  if (eventTypes.length) {
    params.types = eventTypes;
    where.push('type IN {types:Array(String)}');
  }

  for (const key of SOURCE_FILTERS[source]) {
    const values = input.filters[key];
    if (!values?.length) continue;
    // The filter names campaigns; ClickHouse filters on their sending members, never on cmp_ ids.
    params[`filter_${key}`] = key === 'campaign' ? (input.campaignMap?.memberIds ?? []) : values;
    where.push(FILTER_SQL[source][key] as string);
  }
  if (source === 'events') {
    params.names = input.conversionNames;
    where.push('name IN {names:Array(String)}');
  }

  const innerSql = `SELECT ${inner.join(', ')} FROM ${table} FINAL WHERE ${where.join(' AND ')} ${
    groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : ''
  }`;

  // Ratios are computed in the outer query from the aggregated bases. A zero denominator is null,
  // not 0 and not an error, so "no deliveries yet" never looks like a perfect rate.
  const outer: string[] = [...dimAliases];
  if (currencyAlias) outer.push(currencyAlias);
  const outputs: Output[] = [];
  for (const d of dimensions) outputs.push({ kind: 'dimension', dimension: d, alias: alias('dim', d) });
  if (currencyAlias) outputs.push({ kind: 'dimension', dimension: 'currency', alias: currencyAlias });
  for (const m of measures) {
    if (m.kind === 'base') {
      outer.push(`${baseAliases.get(m.id)} AS ${alias('measure', m.id)}`);
      outputs.push({ kind: 'measure', measure: m, alias: alias('measure', m.id) });
    } else {
      const n = baseAliases.get(m.numerator);
      const den = baseAliases.get(m.denominator);
      const a = alias('measure', m.id);
      outer.push(`if(${den} = 0, NULL, ${n} / ${den}) AS ${a}`);
      outputs.push({ kind: 'measure', measure: m, alias: a, numeratorAlias: n, denominatorAlias: den });
    }
  }
  // k_group stays hidden from the output contract; the caller uses it for suppression.
  outer.push('k_group');

  // Default order: time/dimension ascending when there is a breakdown, otherwise the first
  // measure descending. Broadcast defaults to newest first, which is what people mean by "the
  // last four issues".
  const primary = order?.by ?? dimensions[0] ?? measures[0].id;
  const dir = order?.dir ?? (primary === 'broadcast' ? 'desc' : dimensions.length ? 'asc' : 'desc');
  let orderSql: string;
  if ((primary === 'broadcast' || primary === 'journey_step') && dimensions.includes(primary as DimensionId))
    orderSql = sortAlias ?? alias('dim', primary);
  else if (dimensions.includes(primary as DimensionId)) orderSql = alias('dim', primary);
  else orderSql = alias('measure', primary);
  const tieBreak = dimAliases.filter((a) => a !== orderSql).map((a) => `${a} ASC`);

  const sql = `SELECT ${outer.join(', ')} FROM (${innerSql}) ORDER BY ${orderSql} ${dir.toUpperCase()}${
    tieBreak.length ? `, ${tieBreak.join(', ')}` : ''
  } LIMIT {limit:UInt32}`;

  const columns: Column[] = dimensions.map((d) => ({ name: d, kind: 'dimension' as const }));
  if (revenue) columns.push({ name: 'currency', kind: 'dimension' });
  for (const m of measures) columns.push({ name: m.id, kind: 'measure', unit: m.unit });

  return {
    sql,
    params,
    columns,
    outputs,
    kAlias: 'k_group',
    hasNonTimeDimension: dimensions.some((d) => d !== 'day' && d !== 'week' && d !== 'month'),
    revenue,
  };
}

/** What an invalid combination should say, naming the dimensions that would work. */
export function invalidDimensionMessage(measure: MeasureDef, dimension: DimensionId): string {
  return `${measure.id} cannot be broken down by "${dimension}". It supports: ${measure.dimensions.join(', ')}.`;
}
