import { type ConversionMap, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';
import type { ConversionEvent, EventStore } from '@agentic-marketing/events';
import { accessTokenOf, connectionSecrets, type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { googleAdsConnector, metaAdsConnector } from './platforms';

// Spend and ROAS (performance-marketing.md, flow 3): daily cost, impressions, clicks and the
// platform's own conversions per campaign, from Meta Insights and Google Ads reports, next to our
// first-party conversions and revenue attributed by utm_campaign (last touch within a window).

export interface SpendRow {
  platform: 'meta' | 'google';
  account: string;
  campaignId: string;
  campaignName: string;
  date: string;
  cost: number;
  currency: string;
  impressions: number;
  clicks: number;
  platformConversions: number;
}
type Conn = typeof schema.connections.$inferSelect;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Meta Insights: GET act_<id>/insights, level=campaign, one row per campaign and day. */
async function metaSpend(
  conn: Conn,
  secrets: Record<string, unknown>,
  since: string,
  until: string,
  egress: EgressPolicy,
): Promise<SpendRow[]> {
  const s = metaAdsConnector.settings.parse(conn.settings);
  if (!s.adAccountId) throw new AppError('invalid_input', 'Set adAccountId on the Meta connection to import spend.');
  const account = s.adAccountId.startsWith('act_') ? s.adAccountId : `act_${s.adAccountId}`;
  const { accessToken } = metaAdsConnector.secrets.parse(secrets);
  const q = new URLSearchParams({
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
    access_token: accessToken,
  });
  let url: string | undefined = `${s.apiBase.replace(/\/$/, '')}/${s.apiVersion}/${account}/insights?${q}`;
  const rows: SpendRow[] = [];
  for (let page = 0; url && page < 50; page++) {
    const res = await safeRequest(url, { method: 'GET', headers: { accept: 'application/json' } }, egress);
    if (res.status !== 200) throw new Error(`Meta Insights answered ${res.status}: ${res.body.slice(0, 300)}`);
    const body = JSON.parse(res.body) as {
      data: {
        campaign_id: string;
        campaign_name: string;
        spend?: string;
        impressions?: string;
        clicks?: string;
        date_start: string;
        account_currency?: string;
        actions?: { action_type: string; value: string }[];
      }[];
      paging?: { next?: string };
    };
    for (const r of body.data)
      rows.push({
        platform: 'meta',
        account,
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        date: r.date_start,
        cost: Number(r.spend ?? 0),
        currency: r.account_currency ?? '',
        impressions: Number(r.impressions ?? 0),
        clicks: Number(r.clicks ?? 0),
        platformConversions: (r.actions ?? [])
          .filter((a) => ['lead', 'purchase', 'offsite_conversion'].some((t) => a.action_type.includes(t)))
          .reduce((n, a) => n + Number(a.value), 0),
      });
    url = body.paging?.next;
  }
  return rows;
}

/** Google Ads API (v25) GAQL report: campaign cost, impressions, clicks and conversions per day. */
async function googleSpend(
  conn: Conn,
  secrets: Record<string, unknown>,
  since: string,
  until: string,
  egress: EgressPolicy,
): Promise<SpendRow[]> {
  const s = googleAdsConnector.settings.parse(conn.settings);
  const k = googleAdsConnector.secrets.parse(secrets);
  const token = conn.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined;
  if (!token) throw new AppError('conflict', 'Authorize the Google Ads connection first.');
  if (!k.developerToken) throw new AppError('invalid_input', 'Add the developerToken secret to the Google Ads connection to import spend.');
  const query = `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  const rows: SpendRow[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await safeRequest(
      `${s.reportingBase.replace(/\/$/, '')}/v25/customers/${s.customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'developer-token': k.developerToken,
          ...(s.loginCustomerId ? { 'login-customer-id': s.loginCustomerId } : {}),
        },
        body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      },
      egress,
    );
    if (res.status !== 200) throw new Error(`Google Ads answered ${res.status}: ${res.body.slice(0, 300)}`);
    const body = JSON.parse(res.body) as {
      results?: {
        campaign: { id: string; name: string };
        segments: { date: string };
        metrics: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number };
        customer?: { currencyCode?: string };
      }[];
      nextPageToken?: string;
    };
    for (const r of body.results ?? [])
      rows.push({
        platform: 'google',
        account: s.customerId,
        campaignId: String(r.campaign.id),
        campaignName: r.campaign.name,
        date: r.segments.date,
        cost: Number(r.metrics.costMicros ?? 0) / 1_000_000,
        currency: r.customer?.currencyCode ?? '',
        impressions: Number(r.metrics.impressions ?? 0),
        clicks: Number(r.metrics.clicks ?? 0),
        platformConversions: Number(r.metrics.conversions ?? 0),
      });
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return rows;
}

/** Imports the last `days` days of spend for one connection into ClickHouse. */
export async function importSpend(
  db: Db,
  events: EventStore,
  ws: string,
  connectionId: string,
  days: number,
  deps: { kp: KeyProvider; egress: EgressPolicy },
) {
  const { conn, secrets } = await db.withWorkspace(ws, async (tx) => {
    const [c] = await tx.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    return { conn: c, secrets: c ? await connectionSecrets(tx, c, deps.kp) : {} };
  });
  if (!conn) throw new AppError('not_found', `No connection ${connectionId}.`);
  const until = day(new Date());
  const since = day(new Date(Date.now() - (days - 1) * 86_400_000));
  const rows =
    conn.connector === metaAdsConnector.id
      ? await metaSpend(conn, secrets, since, until, deps.egress)
      : conn.connector === googleAdsConnector.id
        ? await googleSpend(conn, secrets, since, until, deps.egress)
        : (() => {
            throw new AppError('invalid_input', `${conn.connector} has no spend reports.`);
          })();
  if (rows.length) {
    const updatedAt = new Date().toISOString().replace('Z', '');
    await events.client.insert({
      table: 'ad_spend',
      format: 'JSONEachRow',
      values: rows.map((r) => ({
        workspace_id: ws,
        platform: r.platform,
        account: r.account,
        campaign_id: r.campaignId,
        campaign_name: r.campaignName,
        date: r.date,
        cost: r.cost,
        currency: r.currency,
        impressions: r.impressions,
        clicks: r.clicks,
        platform_conversions: r.platformConversions,
        updated_at: updatedAt,
      })),
    });
  }
  return { rows: rows.length, since, until };
}

/** Scheduler role: re-imports the last 3 days (late-arriving cost) of every ad account, every 6 hours. */
export async function runSpendImport(
  deps: { db: Db; events: EventStore; kp: KeyProvider; egress: EgressPolicy },
  signal: AbortSignal,
  tickMs = 6 * 3_600_000,
) {
  while (!signal.aborted) {
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
        `SELECT workspace_id, id FROM connections WHERE enabled AND (
           (connector = 'meta_ads' AND settings ? 'adAccountId') OR (connector = 'google_ads' AND oauth_status = 'connected'))`,
      );
      for (const r of rows)
        await importSpend(deps.db, deps.events, r.workspace_id, r.id, 3, deps).catch((err) =>
          logger.warn({ err, connection: r.id }, 'spend import failed'),
        );
    } catch (err) {
      logger.error({ err }, 'spend import round failed');
    }
    await new Promise<void>((r) => {
      const timer = setTimeout(r, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
}

export const importSpendCommand = defineCommand({
  name: 'ads.importSpend',
  title: 'Import ad spend now',
  description:
    'Fetches daily cost, impressions, clicks and platform conversions per campaign for the last N days from Meta or Google Ads (it also runs every 6 hours for the last 3 days).',
  input: z.object({ connection: z.string().regex(/^con_[0-9a-f]{32}$/), days: z.number().int().min(1).max(90).default(30) }),
  output: z.object({ rows: z.number(), since: z.string(), until: z.string() }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'data.write',
  target: (i) => i.connection,
  handler: async (input, ctx) => {
    if (!ctx.services.db) throw new AppError('conflict', 'Spend import needs the database service.');
    try {
      return await importSpend(ctx.services.db, ctx.services.events, ctx.principal.workspaceId, input.connection, input.days, {
        kp: ctx.services.keyProvider,
        egress: ctx.services.egress ?? { allowedHosts: [] },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('conflict', (err as Error).message);
    }
  },
});

const PLATFORM_OF_SOURCE: [RegExp, 'meta' | 'google' | 'microsoft'][] = [
  [/facebook|^fb$|instagram|^ig$|meta/i, 'meta'],
  [/google|adwords/i, 'google'],
  [/bing|microsoft/i, 'microsoft'],
];
const get = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

const Row = z.object({
  platform: z.string(),
  campaignId: z.string(),
  campaignName: z.string(),
  cost: z.number(),
  currency: z.string(),
  impressions: z.number(),
  clicks: z.number(),
  platformConversions: z.number().describe("The platform's own count (its attribution)"),
  conversions: z.number().describe('Our conversions attributed to the campaign (last utm_campaign touch within the window)'),
  revenue: z.number(),
  cpa: z.number().nullable(),
  roas: z.number().nullable(),
});

export const adPerformance = defineCommand({
  name: 'ads.performance',
  title: 'Ad spend, conversions and ROAS per campaign',
  description:
    "Cost, impressions, clicks and the platform's own conversions per campaign, next to our conversions and revenue (events in the conversion map) attributed by last utm_campaign touch (campaign id or name) within the window, with CPA and ROAS. Revenue is summed as is; keep one currency per workspace.",
  input: z.object({
    since: z.iso.date().optional().describe('Default: 30 days ago'),
    until: z.iso.date().optional(),
    windowDays: z.number().int().min(1).max(90).default(30).describe('How far back a utm_campaign visit counts'),
    platform: z.enum(['meta', 'google']).optional(),
  }),
  output: z.object({
    since: z.string(),
    until: z.string(),
    campaigns: z.array(Row),
    unattributed: z.object({ conversions: z.number(), revenue: z.number() }).describe('Conversions with no campaign touch in the window'),
    totals: z.object({ cost: z.number(), conversions: z.number(), revenue: z.number(), roas: z.number().nullable() }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const until = input.until ?? day(new Date());
    const since = input.since ?? day(new Date(Date.now() - 29 * 86_400_000));
    const ch = ctx.services.events.client;
    const clickhouse_settings = await ctx.services.events.settingsFor(ws);
    const spend = await (
      await ch.query({
        query: `SELECT platform, campaign_id, argMax(campaign_name, date) AS campaign_name, sum(cost) AS cost, any(currency) AS currency,
                  sum(impressions) AS impressions, sum(clicks) AS clicks, sum(platform_conversions) AS platform_conversions
                FROM ad_spend FINAL
                WHERE workspace_id = {ws:UUID} AND date BETWEEN {since:Date} AND {until:Date} ${input.platform ? 'AND platform = {platform:String}' : ''}
                GROUP BY platform, campaign_id ORDER BY cost DESC`,
        query_params: { ws, since, until, platform: input.platform ?? '' },
        format: 'JSONEachRow',
        clickhouse_settings,
      })
    ).json<Record<string, string | number>>();

    const key = (platform: string, campaign: string) => `${platform}:${campaign.toLowerCase()}`;
    const rows = spend.map((s) => ({
      platform: String(s.platform),
      campaignId: String(s.campaign_id),
      campaignName: String(s.campaign_name),
      cost: Number(s.cost),
      currency: String(s.currency),
      impressions: Number(s.impressions),
      clicks: Number(s.clicks),
      platformConversions: Number(s.platform_conversions),
      conversions: 0,
      revenue: 0,
      cpa: null as number | null,
      roas: null as number | null,
    }));
    const lookup = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      lookup.set(key(r.platform, r.campaignId), r);
      lookup.set(key(r.platform, r.campaignName), r);
      lookup.set(key('*', r.campaignId), r);
      lookup.set(key('*', r.campaignName), r);
    }
    const unattributed = { conversions: 0, revenue: 0 };
    const windowMs = input.windowDays * 86_400_000;

    // Our conversions: events of the conversion map in the period, with their values. The shared
    // reader pages the whole window by the table's full replacing key instead of a raw
    // `LIMIT 100000`, so no conversion silently falls outside an arbitrary row slice (#786, #366).
    // Each page is attributed and folded into the totals at once, so a window of millions of
    // conversions never has to fit in memory.
    const map: ConversionMap | null = await publishedSingleton(ctx.tx, 'conversion_map');
    const rules = map?.rules ?? [];
    const names = [...new Set(rules.map((r) => r.event))];
    const windowFrom = new Date(`${since}T00:00:00.000Z`);
    const windowUntilEnd = new Date(Date.parse(until) + 86_400_000);

    // The last touch is selected in ClickHouse, not in Node: one visitor with millions of campaign
    // touches made the old per-visitor `.json()` response unbounded even though conversions were
    // paged (#786). Each page's conversions travel as parallel arrays (index, visitor, timestamp),
    // chunked under the same 64 KiB form-field budget, and an ASOF LEFT JOIN returns at most one
    // touch per conversion, bounded above by that conversion's timestamp and below by its window.
    const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    type Lookup = { idx: number; visitor: string; at: number };
    const conversionChunks = (rows: Lookup[]) => {
      const chunks: Lookup[][] = [];
      let chunk: Lookup[] = [];
      let visitorBytes = 2;
      let timeBytes = 2;
      let indexBytes = 2;
      const flush = () => {
        if (!chunk.length) return;
        chunks.push(chunk);
        chunk = [];
        visitorBytes = 2;
        timeBytes = 2;
        indexBytes = 2;
      };
      for (const row of rows) {
        const visitorSize = Buffer.byteLength(JSON.stringify(row.visitor)) * 2 + 3;
        const timeSize = Buffer.byteLength(JSON.stringify(stamp(row.at))) * 2 + 3;
        const indexSize = Buffer.byteLength(String(row.idx)) + 1;
        if (
          chunk.length &&
          (visitorBytes + visitorSize > 64 * 1024 || timeBytes + timeSize > 64 * 1024 || indexBytes + indexSize > 64 * 1024)
        )
          flush();
        chunk.push(row);
        visitorBytes += visitorSize;
        timeBytes += timeSize;
        indexBytes += indexSize;
      }
      flush();
      return chunks;
    };

    const attribute = async (conversions: ConversionEvent[]) => {
      // Empty identifiers never have a touch to look up; a user-id-only conversion stays
      // unattributed.
      const lookups: Lookup[] = conversions.flatMap((c, idx) =>
        c.anonymousId === '' ? [] : [{ idx, visitor: c.anonymousId, at: c.timestamp }],
      );
      const byConversion = new Map<number, { campaign: string; source: string }>();
      for (const chunk of conversionChunks(lookups)) {
        const at = chunk.map((r) => r.at);
        const touches = await (
          await ch.query({
            // Touches with no campaign are dropped before the per-timestamp choice, so an
            // identify at the same timestamp cannot mask a page touch. argMax on event_id then
            // makes two campaign touches at the same timestamp deterministic (the greater event
            // id wins) before the ASOF join picks the latest one. The right side is bounded above
            // by the newest conversion in the chunk, and the outer predicate drops a latest touch
            // that is older than its conversion's window, which is exactly when no touch in the
            // window exists.
            query: `SELECT idx, campaign, source
                    FROM (
                      SELECT tupleElement(z, 1) AS idx, tupleElement(z, 2) AS visitor,
                             toDateTime64(tupleElement(z, 3), 3, 'UTC') AS at
                      FROM (SELECT arrayJoin(arrayZip({idxs:Array(UInt32)}, {visitors:Array(String)}, {times:Array(String)})) AS z)
                    ) AS c
                    ASOF LEFT JOIN (
                      SELECT anonymous_id, timestamp,
                             argMax(touch_campaign, event_id) AS campaign,
                             argMax(touch_source, event_id) AS source
                      FROM (
                        SELECT anonymous_id, timestamp, event_id,
                               coalesce(nullIf(decodeURLFormComponent(extractURLParameter(toString(context.page.url), 'utm_campaign')), ''), toString(context.campaign.name)) AS touch_campaign,
                               coalesce(nullIf(decodeURLFormComponent(extractURLParameter(toString(context.page.url), 'utm_source')), ''), toString(context.campaign.source)) AS touch_source
                        FROM events FINAL
                        WHERE workspace_id = {ws:UUID} AND anonymous_id IN {visitors:Array(String)}
                          AND timestamp >= {from:DateTime64(3, 'UTC')} AND timestamp <= {to:DateTime64(3, 'UTC')}
                      )
                      WHERE touch_campaign != ''
                      GROUP BY anonymous_id, timestamp
                      ORDER BY anonymous_id, timestamp
                    ) AS t
                    ON c.visitor = t.anonymous_id AND c.at >= t.timestamp
                    WHERE t.timestamp >= c.at - toIntervalMillisecond({windowMs:UInt64})
                    ORDER BY idx`,
            query_params: {
              ws,
              idxs: chunk.map((r) => r.idx),
              visitors: chunk.map((r) => r.visitor),
              times: chunk.map((r) => stamp(r.at)),
              from: stamp(Math.min(...at) - windowMs),
              to: stamp(Math.max(...at)),
              windowMs,
            },
            format: 'JSONEachRow',
            clickhouse_settings,
          })
        ).json<{ idx: number | string; campaign: string; source: string }>();
        for (const t of touches) byConversion.set(Number(t.idx), { campaign: String(t.campaign), source: String(t.source) });
      }
      // Attribution is computed per page, which is identical to the whole-window loop because a
      // conversion only reads its own visitor's touches. Pages are ordered by (timestamp, event_id)
      // and no rule dedupes or depends on another conversion, so a batch boundary cannot change the
      // result.
      for (const [idx, c] of conversions.entries()) {
        const touch = byConversion.get(idx);
        const rule = rules.find((r) => r.event === c.name);
        const value = rule?.value ? Number(get(c.properties ?? {}, rule.value)) || 0 : 0;
        const platform = touch ? (PLATFORM_OF_SOURCE.find(([re]) => re.test(touch.source))?.[1] ?? '*') : '*';
        const row = touch ? (lookup.get(key(platform, touch.campaign)) ?? lookup.get(key('*', touch.campaign))) : undefined;
        if (row) {
          row.conversions++;
          row.revenue += value;
        } else {
          unattributed.conversions++;
          unattributed.revenue += value;
        }
      }
    };

    if (names.length)
      await ctx.services.events.conversionEvents(ws, {
        names,
        from: windowFrom,
        // The helper's upper bound is inclusive; the report window ends at the start of the
        // day after `until`, exactly as the old `< untilEnd` predicate did.
        to: new Date(windowUntilEnd.getTime() - 1),
        onPage: attribute,
      });
    for (const r of rows) {
      r.cpa = r.conversions ? Math.round((r.cost / r.conversions) * 100) / 100 : null;
      r.roas = r.cost ? Math.round((r.revenue / r.cost) * 100) / 100 : null;
    }
    const cost = rows.reduce((n, r) => n + r.cost, 0);
    const revenue = rows.reduce((n, r) => n + r.revenue, 0);
    return {
      since,
      until,
      campaigns: rows,
      unattributed,
      totals: {
        cost,
        conversions: rows.reduce((n, r) => n + r.conversions, 0),
        revenue,
        roas: cost ? Math.round((revenue / cost) * 100) / 100 : null,
      },
    };
  },
});

export const spendCommands = [importSpendCommand, adPerformance] as const;
