import { type ConversionMap, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, providerDiagnostic, sleep } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { type ConversionEvent, type EventStore, personReadSource } from '@agentic-marketing/events';
import { accessTokenOf, connectionSecrets, EgressError, type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { clearSpendGaps, readSpendGapsForReport, recordSpendGaps } from './spendGaps';
import { incompleteSpendFor, incompleteSpendNote, type SpendKey } from './spendState';

/**
 * Bounds on last-touch attribution work in ClickHouse (0.14.12 review round 4). Memory is bounded
 * by the join shape; CPU grows with each visitor's campaign touches times their conversions, so a
 * report counts those pairs before it joins and refuses, without partial totals, past a budget.
 * Mutable only so tests can lower them.
 */
/** Campaign touches of a chunk's visitors in its window, with the campaign and source they carry. */
const touchesSql = (protectedRead: boolean) => `SELECT anonymous_id, timestamp, event_id,
         coalesce(nullIf(decodeURLFormComponent(extractURLParameter(toString(context.page.url), 'utm_campaign')), ''), toString(context.campaign.name)) AS touch_campaign,
         coalesce(nullIf(decodeURLFormComponent(extractURLParameter(toString(context.page.url), 'utm_source')), ''), toString(context.campaign.source)) AS touch_source
  FROM ${personReadSource('events', protectedRead)} FINAL
  WHERE workspace_id = {ws:UUID} AND anonymous_id IN {visitors:Array(String)}
    AND timestamp >= {from:DateTime64(3, 'UTC')} AND timestamp <= {to:DateTime64(3, 'UTC')}`;

export const ATTRIBUTION_LIMITS = {
  /** Candidate touch-conversion pairs one attribution query may compare. */
  pairsPerQuery: 10_000_000,
  /** Candidate pairs a whole report may compare across its pages and chunks. */
  pairsPerReport: 50_000_000,
  /**
   * ClickHouse execution limit for each attribution query, in seconds. Below the ClickHouse
   * client's 30 s request timeout, so the server's own deadline answers first.
   */
  queryTimeoutSeconds: 25,
};

/**
 * Whether an error is an attribution query running out of time: the server's deadline
 * (`TIMEOUT_EXCEEDED`, code 159) or the client's request timeout ("Timeout error."), whichever
 * fires first (0.14.12 review round 5).
 */
export function isAttributionTimeout(err: unknown): boolean {
  return /TIMEOUT_EXCEEDED|Timeout exceeded|Timeout error/i.test(String((err as Error)?.message ?? err));
}

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

/**
 * Page ceilings for a spend read. Meta answers 500 campaign-days per page and Google Ads up to
 * 10,000 rows, so these bound a runaway report while staying far above a normal 90-day account.
 * A read that runs into its ceiling is reported as truncated, never silently cut (#917). Mutable so
 * tests can lower them, like ATTRIBUTION_LIMITS.
 */
export const SPEND_LIMITS = { metaPages: 200, googlePages: 50 };

/**
 * Rows per ClickHouse insert (#962). A page is already bounded by the provider, but a chunk cap
 * keeps a single serialised insert small even if a platform ever answers a huge page, and lets the
 * import start writing before the last page has arrived.
 */
export const SPEND_INSERT_CHUNK_ROWS = 5_000;

/** Receives one provider page with the account its rows carry; the import stores each page at once. */
export type SpendPageSink = (rows: readonly SpendRow[], account: string) => void | Promise<void>;

/** Spend rows, the ad account they belong to, and whether the provider had more pages. */
export interface SpendRead {
  rows: SpendRow[];
  /** The account identity an `ad_spend` row carries (Meta `act_…`, Google customer id). */
  account: string;
  truncated: boolean;
}

/**
 * A platform refusing a report is the caller's to fix (account, permissions, token scope), so it is
 * an AppError, but only its own error code and message are copied into the message (#885): the raw
 * body can echo the access token it was called with.
 */
function providerFailure(provider: string, res: { status: number; body: string }): AppError {
  const detail = providerDiagnostic(res.body);
  return new AppError('conflict', `${provider} answered ${res.status}${detail ? `: ${detail}` : ''}.`);
}

/** Meta Insights: GET act_<id>/insights, level=campaign, one row per campaign and day. */
export async function metaSpend(
  conn: Conn,
  secrets: Record<string, unknown>,
  since: string,
  until: string,
  egress: EgressPolicy,
  onPage?: SpendPageSink,
): Promise<SpendRead> {
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
  // With a sink, one page is stored before the next is read: the import never holds the whole read.
  const emit = async (page: SpendRow[]) => {
    if (onPage) await onPage(page, account);
    else rows.push(...page);
  };
  let truncated = false;
  for (let page = 0; url; page++) {
    if (page >= SPEND_LIMITS.metaPages) {
      truncated = true;
      break;
    }
    const res = await safeRequest(url, { method: 'GET', headers: { accept: 'application/json' } }, egress);
    // A provider refusal is expected and its documented code is the caller's diagnostic; the body
    // itself is not (#885): it can echo the access token in this URL back.
    if (res.status !== 200) throw providerFailure('Meta Insights', res);
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
    const pageRows: SpendRow[] = [];
    for (const r of body.data)
      pageRows.push({
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
    await emit(pageRows);
    url = body.paging?.next;
  }
  return { rows, account, truncated };
}

/** Google Ads API (v25) GAQL report: campaign cost, impressions, clicks and conversions per day. */
export async function googleSpend(
  conn: Conn,
  secrets: Record<string, unknown>,
  since: string,
  until: string,
  egress: EgressPolicy,
  onPage?: SpendPageSink,
): Promise<SpendRead> {
  const s = googleAdsConnector.settings.parse(conn.settings);
  const k = googleAdsConnector.secrets.parse(secrets);
  const token = conn.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined;
  if (!token) throw new AppError('conflict', 'Authorize the Google Ads connection first.');
  if (!k.developerToken) throw new AppError('invalid_input', 'Add the developerToken secret to the Google Ads connection to import spend.');
  const query = `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  const rows: SpendRow[] = [];
  // With a sink, one page is stored before the next is read: the import never holds the whole read.
  const emit = async (page: SpendRow[]) => {
    if (onPage) await onPage(page, s.customerId);
    else rows.push(...page);
  };
  let pageToken: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= SPEND_LIMITS.googlePages) {
      truncated = Boolean(pageToken);
      break;
    }
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
    if (res.status !== 200) throw providerFailure('Google Ads', res);
    const body = JSON.parse(res.body) as {
      results?: {
        campaign: { id: string; name: string };
        segments: { date: string };
        metrics: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number };
        customer?: { currencyCode?: string };
      }[];
      nextPageToken?: string;
    };
    const pageRows: SpendRow[] = [];
    for (const r of body.results ?? [])
      pageRows.push({
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
    await emit(pageRows);
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return { rows, account: s.customerId, truncated };
}

/**
 * Stores one spend read page by page, chunk by chunk (#962). The page ceiling is a throughput cap,
 * not a memory cap: each page is inserted as it arrives, so a many-page Google read never has to fit
 * in Node's heap. The incomplete window is recorded before the first insert, so an OOM or a crash
 * mid-import leaves the warning behind rather than losing it with the insert; a complete read
 * removes the window at the end. Chunks share one `updated_at`, so the table's ReplacingMergeTree
 * collapses duplicate rows and a re-import replaces the previous values (#917).
 */
export async function storeSpendPages(
  deps: { db: Db; events: EventStore; ws: string; platform: 'meta' | 'google'; since: string; until: string },
  read: (sink: SpendPageSink) => Promise<SpendRead>,
  chunkRows = SPEND_INSERT_CHUNK_ROWS,
): Promise<{ rows: number; truncated: boolean }> {
  const { db, events, ws, platform, since, until } = deps;
  const updatedAt = new Date().toISOString().replace('Z', '');
  let inserted = 0;
  let gapRecorded = false;
  const sink: SpendPageSink = async (page, account) => {
    if (!page.length) return;
    if (!gapRecorded) {
      await recordSpendGaps(db, ws, { platform, account }, { incomplete: { from: since, to: until } });
      gapRecorded = true;
    }
    for (let at = 0; at < page.length; at += chunkRows) {
      const chunk = page.slice(at, at + chunkRows);
      await events.client.insert({
        table: 'ad_spend',
        format: 'JSONEachRow',
        values: chunk.map((r) => ({
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
      inserted += chunk.length;
    }
  };
  const result = await read(sink);
  // Persist the completeness of this read for `ads.performance`, keyed by the account the spend rows
  // carry (#917 review rounds 2-3): the state follows the stored spend, so renaming the connection,
  // pointing it at another account or deleting it can never clear an older gap, and concurrent
  // imports serialise on that key. The provider does not promise page order, so a truncated read
  // marks the whole requested window as incomplete; a complete read removes exactly the days it
  // covered, for this account only.
  if (result.truncated) {
    if (!gapRecorded) await recordSpendGaps(db, ws, { platform, account: result.account }, { incomplete: { from: since, to: until } });
  } else {
    await recordSpendGaps(db, ws, { platform, account: result.account }, { complete: { from: since, to: until } });
  }
  return { rows: inserted, truncated: result.truncated };
}

/**
 * The (platform, account) keys a report can still read: every Meta and Google connection's account,
 * enabled or not (#953). A gap for any other account is history whose spend rows remain but which no
 * import can complete; `ads.spendGaps.clear` removes it.
 */
export async function readSpendAccounts(tx: Tx): Promise<SpendKey[]> {
  const rows = await tx
    .select({ connector: schema.connections.connector, settings: schema.connections.settings })
    .from(schema.connections)
    .where(or(eq(schema.connections.connector, metaAdsConnector.id), eq(schema.connections.connector, googleAdsConnector.id)));
  const keys: SpendKey[] = [];
  for (const row of rows) {
    if (row.connector === metaAdsConnector.id) {
      const s = metaAdsConnector.settings.safeParse(row.settings);
      if (s.success && s.data.adAccountId)
        keys.push({
          platform: 'meta',
          account: s.data.adAccountId.startsWith('act_') ? s.data.adAccountId : `act_${s.data.adAccountId}`,
        });
    } else if (row.connector === googleAdsConnector.id) {
      const s = googleAdsConnector.settings.safeParse(row.settings);
      if (s.success) keys.push({ platform: 'google', account: s.data.customerId });
    }
  }
  return keys;
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
  const platform = conn.connector === metaAdsConnector.id ? 'meta' : conn.connector === googleAdsConnector.id ? 'google' : null;
  if (!platform) throw new AppError('invalid_input', `${conn.connector} has no spend reports.`);
  const until = day(new Date());
  const since = day(new Date(Date.now() - (days - 1) * 86_400_000));
  const { rows, truncated } = await storeSpendPages({ db, events, ws, platform, since, until }, (sink) =>
    platform === 'meta'
      ? metaSpend(conn, secrets, since, until, deps.egress, sink)
      : googleSpend(conn, secrets, since, until, deps.egress, sink),
  );
  return { rows, since, until, truncated };
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
      for (const r of rows) {
        // Between accounts only (#1043 review): a read already started finishes and stores its
        // pages and its completeness window, so a stop never leaves a false "incomplete" warning
        // behind. Stopping means not starting the next account.
        if (signal.aborted) return;
        await importSpend(deps.db, deps.events, r.workspace_id, r.id, 3, deps).catch((err) => {
          // A stop is not a failed import: the stored window is what a later round replaces.
          if (!signal.aborted) logger.warn({ err, connection: r.id }, 'spend import failed');
        });
      }
    } catch (err) {
      logger.error({ err }, 'spend import round failed');
    }
    await sleep(tickMs, signal);
  }
}

export const importSpendCommand = defineCommand({
  name: 'ads.importSpend',
  title: 'Import ad spend now',
  description:
    'Fetches daily cost, impressions, clicks and platform conversions per campaign for the last N days from Meta or Google Ads (it also runs every 6 hours for the last 3 days). Each read has a page ceiling; truncated is true when the provider had more pages, so the stored cost for that window is incomplete and ads.performance reports it.',
  input: z.object({ connection: z.string().regex(/^con_[0-9a-f]{32}$/), days: z.number().int().min(1).max(90).default(30) }),
  output: z.object({
    rows: z.number(),
    since: z.string(),
    until: z.string(),
    truncated: z
      .boolean()
      .describe(
        'True when the provider had more pages than the import read, so some cost for this window was not stored; re-import a narrower date range',
      ),
  }),
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
      // Provider answers and egress refusals are the caller's diagnostics; anything else (the
      // database, secrets, a bug) propagates as is, so the executor audits and answers it as a
      // sanitised internal failure rather than echoing its text (0.14.16 review round 2).
      if (err instanceof EgressError) throw new AppError('conflict', err.message);
      throw err;
    }
  },
});

export const clearSpendGapsCommand = defineCommand({
  name: 'ads.spendGaps.clear',
  title: 'Clear a spend-gap warning',
  description:
    'Acknowledges and removes the recorded incomplete date ranges of one ad account, so ads.performance stops warning about it and stops discounting its CPA/ROAS. It repairs nothing: stored spend is untouched, so for an account a connection still reads, partial cost stays partial and the warning does not come back, not even after reconnecting; import those days again instead. Use it for a gap no import can complete any more (a re-pointed or deleted connection kept its history). Only people can clear a gap.',
  input: z.object({ platform: z.enum(['meta', 'google']), account: z.string().min(1).max(120) }),
  output: z.object({ cleared: z.number().int().describe('Stored date ranges removed; 0 when the account had no gap') }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'data.write',
  humansOnly: true,
  target: (i) => `${i.platform}:${i.account}`,
  handler: async (input, ctx) => ({ cleared: await clearSpendGaps(ctx.tx, ctx.principal.workspaceId, input) }),
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
    "Cost, impressions, clicks and the platform's own conversions per campaign, next to our conversions and revenue (events in the conversion map) attributed by last utm_campaign touch (campaign id or name) within the window, with CPA and ROAS. Revenue is summed as is; keep one currency per workspace. A conversion with no campaign touch is in unattributed; one whose last touch names a campaign with no spend row is in unmatched, and totals are the campaign rows only. spendTruncated is true when a stored incomplete spend range overlaps this window, so cost is incomplete and CPA is understated while ROAS is overstated; the note names the affected dates.",
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
    unattributed: z
      .object({ conversions: z.number(), revenue: z.number() })
      .describe('Conversions with no campaign touch in the window at all; they are not in totals'),
    unmatched: z
      .object({ conversions: z.number(), revenue: z.number() })
      .describe(
        'Conversions whose last campaign touch names a campaign with no spend row (unknown campaign, different platform) for the window; they are neither attributed to a campaign row nor in unattributed',
      ),
    spendTruncated: z
      .boolean()
      .describe(
        'True when any spend read covering this window was cut at its provider page ceiling, so cost is incomplete: CPA is understated and ROAS overstated',
      ),
    totals: z
      .object({
        cost: z.number(),
        conversions: z.number().describe('Sum of the campaign rows on the conversions measure, not including unattributed or unmatched'),
        revenue: z.number().describe('Sum of the campaign rows on the revenue measure, not including unattributed or unmatched'),
        roas: z.number().nullable(),
      })
      .describe('Sum of the campaign rows only; unattributed and unmatched conversions are reported beside it, never added'),
    notes: z.array(z.string()).describe('Completeness notes, such as a truncated spend read'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const until = input.until ?? day(new Date());
    const since = input.since ?? day(new Date(Date.now() - 29 * 86_400_000));
    // An incomplete spend read is never silent (#917): the import records the date ranges it could
    // not complete against the account whose spend it wrote, and the report says so when one
    // overlaps this window, whether or not that connection still exists.
    const accounts = await readSpendAccounts(ctx.tx);
    const gaps = await readSpendGapsForReport(ctx.tx, { since, until, ...(input.platform ? { platform: input.platform } : {}) });
    const incompleteSpend = incompleteSpendFor(gaps, { since, until, ...(input.platform ? { platform: input.platform } : {}) }, accounts);
    const spendTruncated = incompleteSpend.length > 0;
    const ch = ctx.services.events.client;
    // The shared read-layer decision (#1037 part 2): only a workspace with a durable
    // `erasure_keys` ledger row pays for the protected view's ledger scan.
    const protectedRead = (await ctx.services.events.hasErasures?.(ws)) ?? true;
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
    // A touch that names a campaign with no spend row is not "no touch": it is a campaign we cannot
    // cost, so it gets its own figure and stays out of unattributed (#917).
    const unmatched = { conversions: 0, revenue: 0 };
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

    let reportPairs = 0;
    // A query that still runs past its execution limit fails the report clearly, never with a
    // partial total or a generic server error.
    const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        if (isAttributionTimeout(err))
          throw new AppError(
            'precondition_failed',
            `Attribution for this report took longer than ${ATTRIBUTION_LIMITS.queryTimeoutSeconds} seconds. Narrow the date range or the attribution window.`,
          );
        throw err;
      }
    };
    const attributionSettings = { ...clickhouse_settings, max_execution_time: ATTRIBUTION_LIMITS.queryTimeoutSeconds };
    const attribute = async (conversions: ConversionEvent[]) => {
      // Empty identifiers never have a touch to look up; a user-id-only conversion stays
      // unattributed.
      const lookups: Lookup[] = conversions.flatMap((c, idx) =>
        c.anonymousId === '' ? [] : [{ idx, visitor: c.anonymousId, at: c.timestamp }],
      );
      const byConversion = new Map<number, { campaign: string; source: string }>();
      for (const chunk of conversionChunks(lookups)) {
        const at = chunk.map((r) => r.at);
        // Count the candidate pairs first: one row per visitor, so this read is as small as the
        // chunk. The join below compares every campaign touch of a visitor with each of that
        // visitor's conversions, and a bot-like visitor can make that billions of comparisons.
        const perVisitor = new Map<string, number>();
        for (const r of chunk) perVisitor.set(r.visitor, (perVisitor.get(r.visitor) ?? 0) + 1);
        const counts = await bounded(async () =>
          (
            await ch.query({
              query: `SELECT anonymous_id, count() AS n
                    FROM (${touchesSql(protectedRead)})
                    WHERE touch_campaign != ''
                    GROUP BY anonymous_id`,
              query_params: {
                ws,
                visitors: [...perVisitor.keys()],
                from: stamp(Math.min(...at) - windowMs),
                to: stamp(Math.max(...at)),
              },
              format: 'JSONEachRow',
              clickhouse_settings: attributionSettings,
            })
          ).json<{ anonymous_id: string; n: number | string }>(),
        );
        const pairs = counts.reduce((sum, c) => sum + Number(c.n) * (perVisitor.get(c.anonymous_id) ?? 0), 0);
        reportPairs += pairs;
        if (pairs > ATTRIBUTION_LIMITS.pairsPerQuery || reportPairs > ATTRIBUTION_LIMITS.pairsPerReport)
          throw new AppError(
            'precondition_failed',
            `Attribution for this report would compare ${pairs.toLocaleString('en-US')} campaign touches with conversions in one batch (${reportPairs.toLocaleString('en-US')} so far; the limits are ${ATTRIBUTION_LIMITS.pairsPerQuery.toLocaleString('en-US')} per batch and ${ATTRIBUTION_LIMITS.pairsPerReport.toLocaleString('en-US')} per report). Narrow the date range or the attribution window.`,
          );
        const touches = await bounded(async () =>
          (
            await ch.query({
              // The conversion chunk is the join's build side (the right table of a hash join), and
              // the touches stream past it: ClickHouse holds one chunk of conversions and one
              // aggregate per conversion, never a visitor's touch history, however long it is
              // (0.14.12 review round 3). Touches with no campaign are dropped first, so an identify
              // cannot mask a page touch; argMax on (timestamp, event_id) picks the latest touch in
              // the window, and the greater event id wins a same-timestamp tie. The touch scan is
              // bounded by the chunk's window, and a conversion with no touch in its window has no
              // row (unattributed).
              query: `SELECT c.idx AS idx,
                           argMax(t.touch_campaign, (t.timestamp, t.event_id)) AS campaign,
                           argMax(t.touch_source, (t.timestamp, t.event_id)) AS source
                    FROM (
                      SELECT anonymous_id, timestamp, event_id, touch_campaign, touch_source
                      FROM (${touchesSql(protectedRead)})
                      WHERE touch_campaign != ''
                    ) AS t
                    INNER JOIN (
                      SELECT tupleElement(z, 1) AS idx, tupleElement(z, 2) AS visitor,
                             toDateTime64(tupleElement(z, 3), 3, 'UTC') AS at
                      FROM (SELECT arrayJoin(arrayZip({idxs:Array(UInt32)}, {visitors:Array(String)}, {times:Array(String)})) AS z)
                    ) AS c
                    ON t.anonymous_id = c.visitor
                    WHERE t.timestamp <= c.at AND t.timestamp >= c.at - toIntervalMillisecond({windowMs:UInt64})
                    GROUP BY idx
                    ORDER BY idx
                    SETTINGS join_algorithm = 'hash'`,
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
              clickhouse_settings: attributionSettings,
            })
          ).json<{ idx: number | string; campaign: string; source: string }>(),
        );
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
        } else if (touch) {
          unmatched.conversions++;
          unmatched.revenue += value;
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
    const notes: string[] = [];
    const incompleteNote = incompleteSpendNote(incompleteSpend);
    if (incompleteNote) notes.push(incompleteNote);
    if (unmatched.conversions > 0)
      notes.push(
        `${unmatched.conversions.toLocaleString('en-US')} conversion${unmatched.conversions === 1 ? '' : 's'} had a campaign touch that matches no spend row; they are in unmatched, not in unattributed or the totals.`,
      );
    return {
      since,
      until,
      campaigns: rows,
      unattributed,
      unmatched,
      spendTruncated,
      totals: {
        cost,
        conversions: rows.reduce((n, r) => n + r.conversions, 0),
        revenue,
        roas: cost ? Math.round((revenue / cost) * 100) / 100 : null,
      },
      notes,
    };
  },
});

export const spendCommands = [importSpendCommand, adPerformance, clearSpendGapsCommand] as const;
