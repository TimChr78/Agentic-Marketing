import { artifactTypes, type CampaignDefinition } from '@agentic-marketing/artifacts';
import { goalEventsFor, type IdentityMap, publishedCampaigns } from '@agentic-marketing/campaigns';
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
import { identityQueryParams } from './identityParams';
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
  // Asking for a campaign by id is a historical report: an archived campaign is still measurable
  // by id, so the query map (headline/funnel/revenue) must cover the same members the summary's
  // member rows read from the record. Without this an archived campaign reported a zero headline
  // beside populated member rows (#780).
  const published = await publishedCampaigns(tx, { includeArchived: !!filterCampaignIds?.length });
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
 * The goal event(s) for one campaign. Kept exported here because the compiler and the summary
 * import it from this module; the implementation is shared with campaigns.holdoutResult (#632).
 */
export { goalEventsFor };

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
  /** The shared identity map (#590); omitted in a caller that does not need merge resolution. */
  identity?: IdentityMap;
}

const alias = (prefix: string, id: string) => `${prefix}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

/** Compiles the campaign measures into the same shape analytics.query already consumes. */
export function buildCampaignQuery(input: CampaignBuildInput): CompiledQuery {
  // One entry per campaign, paired by campaign id: the member map is member-aligned, so a campaign
  // with two sending members must never shift its neighbours' attribution window (#629).
  const windows = new Map<string, number>();
  for (const scope of input.queryMap.scopes) if (!windows.has(scope.id)) windows.set(scope.id, scope.goal.attributionDays);
  // The identity map is all or nothing: above its bound it is omitted, and the caller reports that
  // the result is not identity-resolved (#590). The caller scopes it to the campaign's recipients,
  // so unrelated merges elsewhere in the workspace cannot push it over the bound.
  const identity = input.identity?.overLimit ? [] : (input.identity?.pairs ?? []);
  // Each array is split below ClickHouse's per-field limit; the CTE concatenates the parts back.
  const identityParams = identityQueryParams(identity);
  const params: Record<string, unknown> = {
    ws: input.workspaceId,
    tz: input.timeZone,
    from: input.from.replace('Z', ''),
    to: input.to.replace('Z', ''),
    limit: input.limit,
    campaign_map_members: input.queryMap.map.memberIds,
    campaign_map_ids: input.queryMap.map.memberCampaignIds,
    campaign_window_ids: [...windows.keys()],
    campaign_attr_days: [...windows.values()],
    ...identityParams.params,
    identity_count: identityParams.count,
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

  // Recipients resolve through the same map as conversions. A send stored under a profile that
  // later merged away must match an event stored under the survivor, and a person reached as both
  // the historical and the surviving profile must count once (#590).
  const recipient = `recipient AS (
    SELECT
      campaign_id,
      profile_id,
      min(send_at) AS first_at,
      formatDateTime(toStartOfDay(min(send_at), {tz:String}), '%Y-%m-%d') AS send_day,
      formatDateTime(toStartOfWeek(min(send_at), 1, {tz:String}), '%Y-%m-%d') AS send_week,
      formatDateTime(toStartOfMonth(min(send_at), {tz:String}), '%Y-%m-%d') AS send_month
    FROM (
      SELECT
        arrayElement({campaign_map_ids:Array(String)}, indexOf({campaign_map_members:Array(String)}, m.journey_id)) AS campaign_id,
        coalesce(nullIf(by_profile.profile_id, ''), m.profile_id) AS profile_id,
        m.at AS send_at
      FROM message_events m FINAL
      LEFT JOIN identity by_profile ON by_profile.identity_key = m.profile_id AND by_profile.kind = 'profile'
      WHERE m.workspace_id = {ws:UUID}
        AND m.at >= {from:DateTime64(3, 'UTC')} AND m.at <= {to:DateTime64(3, 'UTC')}
        AND m.journey_id IN {campaign_map_members:Array(String)}
        AND m.type IN ('sent', 'delivered')
        AND m.profile_id != ''
    )
    GROUP BY campaign_id, profile_id
  )`;

  const goalMap = `goal_map AS (
    SELECT
      arrayElement({goal_event_campaigns:Array(String)}, number + 1) AS campaign_id,
      arrayElement({goal_events:Array(String)}, number + 1) AS goal_event
    FROM numbers({goal_pair_count:UInt32})
  )`;

  // Every key the identity map knows: a merged-away profile id, or an identifier that moved to its
  // survivor. With an empty map it contributes no rows and the joins fall back to the stored ids.
  const identityMap = `identity AS (
    SELECT
      arrayElement(${identityParams.keys}, number + 1) AS identity_key,
      arrayElement(${identityParams.profiles}, number + 1) AS profile_id,
      arrayElement(${identityParams.kinds}, number + 1) AS kind
    FROM numbers({identity_count:UInt32})
  )`;

  // An event's profile id is historical: a merge does not rewrite it. Resolve it the way the
  // holdout card does, through the user id, then the anonymous id, then a merged-away profile id,
  // and finally the stored id when the map knows nothing better (#590).
  const eventIdentity = `event_identity AS (
    SELECT
      e.event_id AS event_id,
      e.name AS name,
      e.timestamp AS timestamp,
      e.properties AS properties,
      coalesce(
        nullIf(by_user.profile_id, ''),
        nullIf(by_anonymous.profile_id, ''),
        nullIf(by_profile.profile_id, ''),
        e.profile_id
      ) AS profile_id
    FROM events e FINAL
    LEFT JOIN identity by_user ON by_user.identity_key = e.user_id AND by_user.kind = 'user_id'
    LEFT JOIN identity by_anonymous ON by_anonymous.identity_key = e.anonymous_id AND by_anonymous.kind = 'anonymous_id'
    LEFT JOIN identity by_profile ON by_profile.identity_key = e.profile_id AND by_profile.kind = 'profile'
    WHERE e.workspace_id = {ws:UUID}
      AND has({goal_events:Array(String)}, e.name)
      AND e.timestamp >= {from:DateTime64(3, 'UTC')}
  )`;

  const conversionSql = `conversion AS (
    SELECT
      r.campaign_id AS campaign_id,
      i.profile_id AS profile_id,
      r.send_day,
      r.send_week,
      r.send_month,
      i.event_id AS event_id,
      ${conversion.value} AS revenue_value,
      ${conversion.currency} AS currency
    FROM event_identity i
    INNER JOIN recipient r ON r.profile_id = i.profile_id
    INNER JOIN goal_map g ON g.campaign_id = r.campaign_id AND g.goal_event = i.name
    WHERE i.timestamp >= r.first_at
      AND i.timestamp <= addDays(
        r.first_at,
        arrayElement({campaign_attr_days:Array(Int32)}, indexOf({campaign_window_ids:Array(String)}, r.campaign_id))
      )
  )`;

  const recRoll = `rec_roll AS (
    SELECT ${dimSql.length ? `${dimSql.join(', ')}, ` : ''}uniqExact(profile_id) AS base_campaign_recipients
    FROM recipient
    ${groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : ''}
  )`;

  // Currency partitions revenue, not people. Grouping the converter roll by currency too would
  // count a person once per conversion currency and make campaign.converters / conversion_rate
  // depend on whether an unrelated revenue measure was requested (#779). Converters stay a single
  // total per dimension group; a separate revenue roll is joined for the per-currency columns.
  const convSql = `conv_roll AS (
    SELECT ${dimSql.length ? `${dimSql.join(', ')}, ` : ''}uniqExact(profile_id) AS base_campaign_converters
    FROM conversion
    ${groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : ''}
  )${
    revenue
      ? `, rev_roll AS (
    SELECT ${dimSql.length ? `${dimSql.join(', ')}, ` : ''}currency AS ${currencyAlias},
      sum(revenue_value) AS base_campaign_revenue
    FROM conversion
    GROUP BY ${[...groupBy, 'currency'].join(', ')}
  )`
      : ''
  }`;

  const outer: string[] = dimensions.map((d) => `r.${alias('dim', d)} AS ${alias('dim', d)}`);
  // Name every dimension column explicitly: rev_roll adds a second definition of the dimension
  // columns, and ClickHouse otherwise emits the joined expression under its qualified name
  // (`r.dim_campaign`), which the runner's alias lookup cannot read.
  if (revenue) outer.push(`rv.${currencyAlias} AS ${currencyAlias}`);
  outer.push('r.base_campaign_recipients AS base_campaign_recipients');
  outer.push('ifNull(c.base_campaign_converters, 0) AS base_campaign_converters');
  if (revenue) outer.push('ifNull(rv.base_campaign_revenue, 0) AS base_campaign_revenue');
  outer.push('r.base_campaign_recipients AS k_group');

  const measureSql: string[] = [];
  const outputs: Output[] = dimensions.map((d) => ({ kind: 'dimension', dimension: d, alias: alias('dim', d) }));
  if (revenue) outputs.push({ kind: 'dimension', dimension: 'currency', alias: currencyAlias });
  const baseSelect = (id: string): string => {
    const target = alias('measure', id);
    if (id === 'campaign.recipients') return `r.base_campaign_recipients AS ${target}`;
    if (id === 'campaign.converters') return `ifNull(c.base_campaign_converters, 0) AS ${target}`;
    if (id === 'campaign.revenue') return `ifNull(rv.base_campaign_revenue, 0) AS ${target}`;
    throw new Error(`${id} is not a campaign measure`);
  };
  const selected = new Set<string>();
  for (const m of input.measures) {
    const target = alias('measure', m.id);
    if (m.id === 'campaign.conversion_rate')
      measureSql.push(
        `if(r.base_campaign_recipients = 0, NULL, ifNull(c.base_campaign_converters, 0) / r.base_campaign_recipients) AS ${target}`,
      );
    else if (m.id === 'campaign.revenue_per_recipient')
      measureSql.push(
        `if(r.base_campaign_recipients = 0, NULL, ifNull(rv.base_campaign_revenue, 0) / r.base_campaign_recipients) AS ${target}`,
      );
    else measureSql.push(baseSelect(m.id));
    selected.add(m.id);
    outputs.push({
      kind: 'measure',
      measure: m,
      alias: target,
      ...(m.kind === 'ratio' ? { numeratorAlias: alias('measure', m.numerator), denominatorAlias: alias('measure', m.denominator) } : {}),
    });
  }
  // A ratio's numeratorAlias/denominatorAlias must name a selected column even when the caller did
  // not request that base measure; buildQuery always selects the bases its ratios name.
  for (const m of input.measures) {
    if (m.kind !== 'ratio') continue;
    for (const id of [m.numerator, m.denominator]) {
      if (selected.has(id)) continue;
      measureSql.push(baseSelect(id));
      selected.add(id);
    }
  }

  const joinKeys = dimensions.map((d) => `r.${alias('dim', d)} = c.${alias('dim', d)}`);
  const revenueJoinKeys = dimensions.map((d) => `r.${alias('dim', d)} = rv.${alias('dim', d)}`);
  // conv_roll and rev_roll only hold groups that converted, so each join must keep every
  // recipient group: otherwise a campaign with recipients and no conversions disappears (#630).
  // The revenue roll is joined separately on the dimensions only; its currency column is the
  // breakdown, and each currency row repeats the same single-total converter count (#779).
  const joined = `FROM rec_roll r LEFT JOIN conv_roll c${joinKeys.length ? ` ON ${joinKeys.join(' AND ')}` : ' ON 1 = 1'}${
    revenue ? ` LEFT JOIN rev_roll rv${revenueJoinKeys.length ? ` ON ${revenueJoinKeys.join(' AND ')}` : ' ON 1 = 1'}` : ''
  }`;

  const columns: Column[] = dimensions.map((d) => ({ name: d, kind: 'dimension' as const }));
  if (revenue) columns.push({ name: 'currency', kind: 'dimension' });
  for (const m of input.measures) columns.push({ name: m.id, kind: 'measure', unit: m.unit as Unit });

  const primary = input.order?.by ?? dimensions[0] ?? input.measures[0].id;
  const dir = input.order?.dir ?? (dimensions.length ? 'asc' : 'desc');
  const orderSql = dimensions.includes(primary as DimensionId) ? `r.${alias('dim', primary)}` : alias('measure', primary);

  const sql = `WITH ${identityMap}, ${recipient}, ${goalMap}, ${eventIdentity}, ${conversionSql}, ${recRoll}, ${convSql}
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
