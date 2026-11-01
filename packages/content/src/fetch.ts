import type { Db, Tx } from '@agentic-marketing/db';
import { schema } from '@agentic-marketing/db';
import { type EgressPolicy, safeRequest } from '@agentic-marketing/integrations';
import { logger } from '@agentic-marketing/telemetry';
import { eq, sql } from 'drizzle-orm';
import { type ContentSourceRow, ingestFeed } from './ingest';
import { parseFeed } from './parse';

// Fetching content sources (#140): conditional GET through the existing egress guard, bounded time
// and bytes, retries with backoff, and a consecutive-failure count a person and `content.sources.list`
// can see. A broken source never stops the rest of the sweep.

export interface ContentFetchOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxItemsPerFetch?: number;
  /** Pauses between attempts, per attempt; 2 entries means 3 attempts in total. */
  retryDelaysMs?: number[];
  /** Minimum gap between two requests to the same host in one sweep. */
  hostGapMs?: number;
  /** Sources fetched per workspace per sweep. */
  maxSourcesPerRun?: number;
}

export interface ContentFetchDeps extends ContentFetchOptions {
  db: Db;
  egress: EgressPolicy;
}

/** What fetching one source needs: the egress policy and the bounds, without the pool. */
export type SourceFetchDeps = Omit<ContentFetchDeps, 'db'>;

export type ContentFetchStatus = 'ok' | 'not_modified' | 'failed';

export interface SourceFetchResult {
  sourceId: string;
  status: ContentFetchStatus;
  itemsAdded: number;
  itemsUpdated: number;
  error: string | null;
}

export interface ContentFetchSummary {
  workspaces: number;
  sources: number;
  ok: number;
  notModified: number;
  failed: number;
  itemsAdded: number;
  itemsUpdated: number;
}

const DEFAULT_USER_AGENT = 'agentic-marketing-content/1 (+https://github.com/TimChr78/Agentic-Marketing)';
const MAX_ERROR_LENGTH = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function failureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * One conditional GET, with retries for timeouts, network errors, 429 and 5xx. A 304 is a success:
 * the feed did not change and the etag/last-modified stay as they are.
 */
interface FeedRequestOptions extends SourceFetchDeps {
  timeoutMs: number;
  maxBytes: number;
}

async function requestFeed(url: string, headers: Record<string, string>, options: FeedRequestOptions) {
  const delays = options.retryDelaysMs ?? [200, 500];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await safeRequest(
        url,
        { method: 'GET', headers, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes },
        options.egress,
      );
      if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
        await sleep(delays[attempt] ?? 0);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= delays.length) throw err;
      await sleep(delays[attempt] ?? 0);
    }
  }
}

type HostLimiter = (url: string) => Promise<void>;

function hostLimiter(gapMs: number): HostLimiter {
  const last = new Map<string, number>();
  return async (url) => {
    const host = new URL(url).host;
    const previous = last.get(host);
    const now = Date.now();
    if (previous !== undefined && gapMs > 0) {
      const wait = gapMs - (now - previous);
      if (wait > 0) await sleep(wait);
    }
    last.set(host, Date.now());
  };
}

async function markFailure(tx: Tx, source: ContentSourceRow, now: Date, error: string): Promise<void> {
  await tx
    .update(schema.contentSources)
    .set({
      lastFetchAt: now,
      lastError: error,
      consecutiveFailures: sql`${schema.contentSources.consecutiveFailures} + 1`,
      updatedAt: now,
    })
    .where(eq(schema.contentSources.id, source.id));
}

/**
 * Fetch one source and store what it returned. Network and parse errors are recorded on the source
 * and reported, not thrown, so one failing feed cannot fail the sweep or an on-demand fetch of it.
 */
export async function fetchSource(
  tx: Tx,
  source: ContentSourceRow,
  deps: SourceFetchDeps,
  now: Date = new Date(),
  throttle?: HostLimiter,
): Promise<SourceFetchResult> {
  const headers: Record<string, string> = {
    accept: 'application/feed+json, application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5',
    'user-agent': deps.userAgent ?? DEFAULT_USER_AGENT,
  };
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.lastModified) headers['if-modified-since'] = source.lastModified;

  try {
    await throttle?.(source.url);
    const res = await requestFeed(source.url, headers, {
      ...deps,
      timeoutMs: deps.timeoutMs ?? 10_000,
      maxBytes: deps.maxBytes ?? 1024 * 1024,
    });

    if (res.status === 304) {
      await tx
        .update(schema.contentSources)
        .set({ lastFetchAt: now, lastError: null, consecutiveFailures: 0, updatedAt: now })
        .where(eq(schema.contentSources.id, source.id));
      return { sourceId: source.id, status: 'not_modified', itemsAdded: 0, itemsUpdated: 0, error: null };
    }

    if (res.status < 200 || res.status >= 300) {
      const error = `HTTP ${res.status}`;
      await markFailure(tx, source, now, error);
      return { sourceId: source.id, status: 'failed', itemsAdded: 0, itemsUpdated: 0, error };
    }

    const feed = parseFeed(source.kind, res.body, source.url);
    const ingested = await ingestFeed(tx, source, feed.items, now, deps.maxItemsPerFetch ?? 100);
    await tx
      .update(schema.contentSources)
      .set({
        lastFetchAt: now,
        etag: res.headers.etag ?? source.etag,
        lastModified: res.headers['last-modified'] ?? source.lastModified,
        lastError: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(schema.contentSources.id, source.id));
    return {
      sourceId: source.id,
      status: 'ok',
      itemsAdded: ingested.added,
      itemsUpdated: ingested.updated,
      error: null,
    };
  } catch (err) {
    const error = failureMessage(err);
    await markFailure(tx, source, now, error);
    return { sourceId: source.id, status: 'failed', itemsAdded: 0, itemsUpdated: 0, error };
  }
}

/** Whether a source is due: its interval, stretched by its consecutive failures (backoff across runs). */
export function isSourceDue(
  source: Pick<ContentSourceRow, 'enabled' | 'lastFetchAt' | 'fetchIntervalMinutes' | 'consecutiveFailures'>,
  now: Date,
): boolean {
  if (!source.enabled) return false;
  if (!source.lastFetchAt) return true;
  const factor = source.consecutiveFailures > 0 ? Math.min(2 ** Math.min(source.consecutiveFailures, 4), 16) : 1;
  const intervalMs = source.fetchIntervalMinutes * 60_000 * factor;
  return now.getTime() - source.lastFetchAt.getTime() >= intervalMs;
}

/**
 * One scheduler sweep: every workspace's due sources, sequentially, with a per-host gap. The
 * scheduler calls this; tests pass a clock and a local feed server.
 */
export async function runContentFetchOnce(deps: ContentFetchDeps, now: Date = new Date()): Promise<ContentFetchSummary> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string }>('SELECT DISTINCT workspace_id FROM content_sources WHERE enabled');
  const summary: ContentFetchSummary = {
    workspaces: 0,
    sources: 0,
    ok: 0,
    notModified: 0,
    failed: 0,
    itemsAdded: 0,
    itemsUpdated: 0,
  };
  const throttle = hostLimiter(deps.hostGapMs ?? 1000);
  for (const { workspace_id: workspaceId } of rows) {
    summary.workspaces++;
    try {
      await deps.db.withWorkspace(workspaceId, async (tx) => {
        const sources = await tx.select().from(schema.contentSources).where(eq(schema.contentSources.enabled, true));
        const due = sources.filter((source) => isSourceDue(source, now)).slice(0, deps.maxSourcesPerRun ?? 20);
        for (const source of due) {
          const result = await fetchSource(tx, source, deps, now, throttle);
          summary.sources++;
          if (result.status === 'ok') summary.ok++;
          else if (result.status === 'not_modified') summary.notModified++;
          else summary.failed++;
          summary.itemsAdded += result.itemsAdded;
          summary.itemsUpdated += result.itemsUpdated;
        }
      });
    } catch (err) {
      logger.error({ err, workspaceId }, 'content fetch round failed');
    }
  }
  return summary;
}

/** The scheduler job: every five minutes by default; each source keeps its own interval. */
export async function runContentFetches(deps: ContentFetchDeps, signal: AbortSignal, opts: { tickMs?: number } = {}) {
  const tickMs = opts.tickMs ?? 5 * 60_000;
  logger.info('scheduler role: content sources');
  while (!signal.aborted) {
    try {
      await runContentFetchOnce(deps);
    } catch (err) {
      logger.error({ err }, 'content fetch round failed');
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
