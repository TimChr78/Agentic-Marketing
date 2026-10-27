import { artifactTypes, type CampaignDefinition } from '@agentic-marketing/artifacts';
import { publishedCampaigns } from '@agentic-marketing/campaigns';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  type CampaignMap,
  type Column,
  type CompiledQuery,
  type ConversionRule,
  type NormalizedFilters,
  type Output,
  revenueExpressions,
} from './compile';
import type { DimensionId, MeasureDef, Unit } from './registry';

// Campaign evaluation (#66) is a small SQL builder of its own. Recipients come from
// message_events, conversions from events, and the join is the attribution rule; keeping it
// beside the generic compiler lets both use the same registry and parameter discipline.

const MAX_CAMPAIGNS = 50;
const MAX_MEMBERS = 50;

export interface CampaignGoal {
  kind: 'conversion' | 'revenue' | 'engagement' | 'signups' | 'custom';
  event: string | null;
  target: number | null;
  attributionDays: number;
}

export interface CampaignMember {
  artifactId: string;
  name: string;
  type: string;
  role: 'primary' | 'follow_up' | 'content';
  published: boolean;
}

export interface CampaignRecord {
  id: string;
  name: string;
  version: number;
  published: boolean;
  goal: CampaignGoal;
  utmCampaign: string | null;
  startsAt: string | null;
  members: CampaignMember[];
}

export interface CampaignScope {
  id: string;
  name: string;
  goal: CampaignGoal;
  memberIds: string[];
  goalEvents: string[];
}

export interface CampaignQueryMap {
  map: CampaignMap;
  /** The campaigns the map covers, with the goal and window for each. */
  scopes: CampaignScope[];
  /** Campaigns and their sending members, used by the summary. */
  records: CampaignRecord[];
}

const goalFrom = (content: CampaignDefinition): CampaignGoal => ({
  kind: content.goal.kind,
  event: content.goal.event ?? null,
  target: content.goal.target ?? null,
  attributionDays: content.goal.attributionDays,
});

const SENDING_TYPES = new Set(['broadcast', 'journey']);

async function memberRows(tx: Tx, ids: string[]): Promise<CampaignMember[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select({
      id: schema.artifacts.id,
      name: schema.artifacts.name,
      type: schema.artifacts.type,
      publishedVersion: schema.artifacts.publishedVersion,
    })
    .from(schema.artifacts)
    .where(inArray(schema.artifacts.id, ids));
  return rows.map((a) => ({
    artifactId: a.id,
    name: a.name,
    type: a.type,
    role: 'primary' as const,
    published: a.publishedVersion !== null,
  }));
}

/** The published campaigns and their sending members, bounded for the parameter arrays. */
export async function loadCampaignQueryMap(
  tx: Tx,
  filterCampaignIds: string[] | undefined,
  conversionMapEvents: readonly string[],
): Promise<CampaignQueryMap> {
  const published = await publishedCampaigns(tx);
  const chosen = (filterCampaignIds?.length ? published.filter((c) => filterCampaignIds.includes(c.id)) : published).slice(
    0,
    MAX_CAMPAIGNS,
  );
  const memberIds = [...new Set(chosen.flatMap((c) => c.content.members.map((m) => m.artifactId)))];
  const artifacts = await tx
    .select({ id: schema.artifacts.id, type: schema.artifacts.type })
    .from(schema.artifacts)
    .where(memberIds.length ? inArray(schema.artifacts.id, memberIds) : undefined);
  const typeById = new Map(artifacts.map((a) => [a.id, a.type]));

  const records: CampaignRecord[] = chosen.map((c) => ({
    id: c.id,
    name: c.name,
    version: c.version,
    published: true,
    goal: goalFrom(c.content),
    utmCampaign: c.content.utmCampaign ?? null,
    startsAt: c.content.startsAt ?? null,
    members: c.content.members.slice(0, MAX_MEMBERS).flatMap((m) => {
      const type = typeById.get(m.artifactId);
      if (!type) return [];
      return [{ artifactId: m.artifactId, name: m.artifactId, type, role: m.role, published: true }];
    }),
  }));

  const scopes: CampaignScope[] = records.map((r) => {
    const sending = r.members.filter((m) => SENDING_TYPES.has(m.type));
    return {
      id: r.id,
      name: r.name,
      goal: r.goal,
      memberIds: sending.map((m) => m.artifactId),
      goalEvents: goalEventsFor(r.goal, conversionMapEvents),
    };
  });

  const mapMembers: string[] = [];
  const mapCampaigns: string[] = [];
  for (const scope of scopes)
    for (const memberId of scope.memberIds) {
      mapMembers.push(memberId);
      mapCampaigns.push(scope.id);
    }

  return { map: { memberIds: mapMembers, memberCampaignIds: mapCampaigns }, scopes, records };
}

/**
 * The goal event(s) for one campaign. Revenue goals follow the conversion map, because that is
 * where the value and currency live; other goals use the event the campaign names.
 */
export function goalEventsFor(goal: CampaignGoal, conversionMapEvents: readonly string[]): string[] {
  if (goal.kind === 'revenue' && conversionMapEvents.length) {
    return [...new Set([...conversionMapEvents, ...(goal.event ? [goal.event] : [])])];
  }
  return goal.event ? [goal.event] : [];
}

/** One campaign, including its never-published latest version, for the summary's readiness state. */
export async function loadCampaignRecord(tx: Tx, campaignId: string): Promise<CampaignRecord> {
  const [a] = await tx
    .select({
      id: schema.artifacts.id,
      name: schema.artifacts.name,
      type: schema.artifacts.type,
      latestVersion: schema.artifacts.latestVersion,
      publishedVersion: schema.artifacts.publishedVersion,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, campaignId));
  if (a?.type !== 'campaign') throw new AppError('not_found', `Campaign ${campaignId} does not exist in this workspace.`);
  const version = a.publishedVersion ?? a.latestVersion;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, campaignId), eq(schema.artifactVersions.number, version)));
  if (!v) throw new AppError('not_found', `Campaign ${campaignId} has no version ${version}.`);
  const content = artifactTypes.campaign.content.parse(v.content) as CampaignDefinition;
  const members = await memberRows(
    tx,
    content.members.map((m) => m.artifactId),
  );
  const byId = new Map(members.map((m) => [m.artifactId, m]));
  return {
    id: a.id,
    name: a.name,
    version,
    published: a.publishedVersion !== null,
    goal: goalFrom(content),
    utmCampaign: content.utmCampaign ?? null,
    startsAt: content.startsAt ?? null,
    members: content.members.map((m) => {
      const found = byId.get(m.artifactId);
      return {
        artifactId: m.artifactId,
        name: found?.name ?? m.artifactId,
        type: found?.type ?? 'unknown',
        role: m.role,
        published: found?.published ?? false,
      };
    }),
  };
}

export interface CampaignBuildInput {
  workspaceId: string;
  measures: MeasureDef[];
  dimensions: DimensionId[];
  from: string;
  to: string;
  timeZone: string;
  filters: NormalizedFilters;
  limit: number;
  order?: { by: string; dir: 'asc' | 'desc' };
  conversionRules: ConversionRule[];
  queryMap: CampaignQueryMap;
}

const alias = (prefix: string, id: string) => `${prefix}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

/** Compiles the campaign measures into the same shape analytics.query already consumes. */
export function buildCampaignQuery(input: CampaignBuildInput): CompiledQuery {
  const params: Record<string, unknown> = {
    ws: input.workspaceId,
    tz: input.timeZone,
    from: input.from.replace('Z', ''),
    to: input.to.replace('Z', ''),
    limit: input.limit,
    campaign_map_members: input.queryMap.map.memberIds,
    campaign_map_ids: input.queryMap.map.memberCampaignIds,
    campaign_attr_days: input.queryMap.scopes.map((s) => s.goal.attributionDays),
  };
  const conversion = revenueExpressions(input.conversionRules, params);
  const goalPairs = input.queryMap.scopes.flatMap((s) => s.goalEvents.map((event) => ({ campaignId: s.id, event })));
  params.goal_events = goalPairs.map((p) => p.event);
  params.goal_event_campaigns = goalPairs.map((p) => p.campaignId);
  params.goal_pair_count = goalPairs.length;

  const dimensions = input.dimensions;
  const dimExpression: Partial<Record<DimensionId, string>> = {
    campaign: 'campaign_id',
    day: 'send_day',
    week: 'send_week',
    month: 'send_month',
  };
  const dimSql = dimensions.map((d) => `${dimExpression[d] ?? 'campaign_id'} AS ${alias('dim', d)}`);
  const groupBy = dimensions.map((d) => alias('dim', d));
  const currencyAlias = 'dim_currency';

  const revenue = input.measures.some((m) => m.id === 'campaign.revenue' || (m.kind === 'ratio' && m.numerator === 'campaign.revenue'));

  const recipient = `recipient AS (
    SELECT
      arrayElement({campaign_map_ids:Array(String)}, indexOf({campaign_map_members:Array(String)}, journey_id)) AS campaign_id,
      profile_id,
      min(at) AS first_at,
      formatDateTime(toStartOfDay(min(at), {tz:String}), '%Y-%m-%d') AS send_day,
      formatDateTime(toStartOfWeek(min(at), 1, {tz:String}), '%Y-%m-%d') AS send_week,
      formatDateTime(toStartOfMonth(min(at), {tz:String}), '%Y-%m-%d') AS send_month
    FROM message_events FINAL
    WHERE workspace_id = {ws:UUID}
      AND at >= {from:DateTime64(3, 'UTC')} AND at <= {to:DateTime64(3, 'UTC')}
      AND journey_id IN {campaign_map_members:Array(String)}
      AND type IN ('sent', 'delivered')
      AND profile_id != ''
    GROUP BY campaign_id, profile_id
  )`;

  const goalMap = `goal_map AS (
    SELECT
      arrayElement({goal_event_campaigns:Array(String)}, number + 1) AS campaign_id,
      arrayElement({goal_events:Array(String)}, number + 1) AS goal_event
    FROM numbers({goal_pair_count:UInt32})
  )`;

  const conversionSql = `conversion AS (
    SELECT
      r.campaign_id AS campaign_id,
      r.profile_id AS profile_id,
      r.send_day,
      r.send_week,
      r.send_month,
      e.event_id AS event_id,
      ${conversion.value} AS revenue_value,
      ${conversion.currency} AS currency
    FROM events e FINAL
    INNER JOIN recipient r ON r.profile_id = e.profile_id
    INNER JOIN goal_map g ON g.campaign_id = r.campaign_id AND g.goal_event = e.name
    WHERE e.workspace_id = {ws:UUID}
      AND e.timestamp >= r.first_at
      AND e.timestamp <= addDays(
        r.first_at,
        arrayElement({campaign_attr_days:Array(Int32)}, indexOf({campaign_map_ids:Array(String)}, r.campaign_id))
      )
  )`;

  const recRoll = `rec_roll AS (
    SELECT ${dimSql.length ? `${dimSql.join(', ')}, ` : ''}uniqExact(profile_id) AS base_campaign_recipients
    FROM recipient
    ${groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : ''}
  )`;

  const convSql = `conv_roll AS (
    SELECT ${dimSql.length ? `${dimSql.join(', ')}, ` : ''}${revenue ? `currency AS ${currencyAlias}, ` : ''}
      uniqExact(profile_id) AS base_campaign_converters
      ${revenue ? ', sum(revenue_value) AS base_campaign_revenue' : ''}
    FROM conversion
    ${groupBy.length || revenue ? `GROUP BY ${[...groupBy, ...(revenue ? ['currency'] : [])].join(', ')}` : ''}
  )`;

  const outer: string[] = dimensions.map((d) => `r.${alias('dim', d)}`);
  if (revenue) outer.push(`c.${currencyAlias}`);
  outer.push('r.base_campaign_recipients AS base_campaign_recipients');
  outer.push('ifNull(c.base_campaign_converters, 0) AS base_campaign_converters');
  if (revenue) outer.push('c.base_campaign_revenue AS base_campaign_revenue');
  outer.push('r.base_campaign_recipients AS k_group');

  const measureSql: string[] = [];
  const outputs: Output[] = dimensions.map((d) => ({ kind: 'dimension', dimension: d, alias: alias('dim', d) }));
  if (revenue) outputs.push({ kind: 'dimension', dimension: 'currency', alias: currencyAlias });
  for (const m of input.measures) {
    const target = alias('measure', m.id);
    if (m.id === 'campaign.recipients') measureSql.push(`r.base_campaign_recipients AS ${target}`);
    else if (m.id === 'campaign.converters') measureSql.push(`ifNull(c.base_campaign_converters, 0) AS ${target}`);
    else if (m.id === 'campaign.revenue') measureSql.push(`c.base_campaign_revenue AS ${target}`);
    else if (m.id === 'campaign.conversion_rate')
      measureSql.push(
        `if(r.base_campaign_recipients = 0, NULL, ifNull(c.base_campaign_converters, 0) / r.base_campaign_recipients) AS ${target}`,
      );
    else if (m.id === 'campaign.revenue_per_recipient')
      measureSql.push(`if(r.base_campaign_recipients = 0, NULL, c.base_campaign_revenue / r.base_campaign_recipients) AS ${target}`);
    else throw new Error(`${m.id} is not a campaign measure`);
    outputs.push({
      kind: 'measure',
      measure: m,
      alias: target,
      ...(m.kind === 'ratio' ? { numeratorAlias: alias('measure', m.numerator), denominatorAlias: alias('measure', m.denominator) } : {}),
    });
  }

  const joinKeys = dimensions.map((d) => `r.${alias('dim', d)} = c.${alias('dim', d)}`);
  const joined = `FROM rec_roll r ${revenue ? 'INNER' : 'LEFT'} JOIN conv_roll c${
    joinKeys.length ? ` ON ${joinKeys.join(' AND ')}` : ' ON 1 = 1'
  }`;

  const columns: Column[] = dimensions.map((d) => ({ name: d, kind: 'dimension' as const }));
  if (revenue) columns.push({ name: 'currency', kind: 'dimension' });
  for (const m of input.measures) columns.push({ name: m.id, kind: 'measure', unit: m.unit as Unit });

  const primary = input.order?.by ?? dimensions[0] ?? input.measures[0].id;
  const dir = input.order?.dir ?? (dimensions.length ? 'asc' : 'desc');
  const orderSql = dimensions.includes(primary as DimensionId) ? `r.${alias('dim', primary)}` : alias('measure', primary);

  const sql = `WITH ${recipient}, ${goalMap}, ${conversionSql}, ${recRoll}, ${convSql}
    SELECT ${[...outer, ...measureSql].join(', ')}
    ${joined}
    ORDER BY ${orderSql} ${dir.toUpperCase()} LIMIT {limit:UInt32}`;

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
