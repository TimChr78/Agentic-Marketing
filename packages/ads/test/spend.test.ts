import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { failFakeServer } from '../../../test-support/index';
import { adPerformance, googleSpend, metaSpend, SPEND_INSERT_CHUNK_ROWS, SPEND_LIMITS, storeSpendPages } from '../src/spend';

// #786: ads.performance used to read conversion events with a raw `LIMIT 100000` and no order,
// paging or truncation signal, so a busy window silently lost conversions, revenue, CPA and ROAS.
// It now pages through the shared events.conversionEvents helper (#366), which walks the whole
// window by (timestamp, event_id). This fake store returns more than the old cap: every event must
// reach the attribution loop, without inserting 100,000 rows into ClickHouse.
const OLD_CAP = 100_000;
const CONVERSION_COUNT = OLD_CAP + 1;

type GapRow = { platform: string; account: string; fromDate: string; toDate: string };
type ConnectionRow = { connector: string; settings: Record<string, unknown> };

/** The smallest tx shape publishedSingleton's conversion-map lookup, accounts and spend gaps read use. */
const commandTx = (rules: { event: string; value?: string }[], gaps: GapRow[] = [], accounts: ConnectionRow[] = [META_CONNECTION]) =>
  ({
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === schema.connections ? accounts : gaps),
        innerJoin: () => ({
          where: async () => [{ content: { rules } }],
        }),
      }),
    }),
  }) as never;

const META_CONNECTION: ConnectionRow = { connector: 'meta_ads', settings: { pixelId: '123456789', adAccountId: 'act_10001' } };

const context = (gaps: GapRow[] = []): CommandContext => {
  const paged = Array.from({ length: CONVERSION_COUNT }, (_, i) => ({
    profileId: '',
    anonymousId: '',
    userId: '',
    name: 'Order Completed',
    timestamp: Date.parse('2026-01-05T00:00:00.000Z') + i,
    properties: {},
  }));
  // What the old raw query answered: exactly the 100,000-row slice, with no room for the last one.
  const capped = Array.from({ length: OLD_CAP }, () => ({
    anonymous_id: '',
    timestamp: '2026-01-05 00:00:00.000',
    name: 'Order Completed',
    properties: '{}',
  }));
  const events = {
    settingsFor: async () => ({}),
    // The real store streams page by page when onPage is given; mimic that so the report folds
    // every event without ever holding the whole window in one array (#786).
    conversionEvents: async (_ws: string, q: { onPage?: (rows: typeof paged) => void | Promise<void>; pageSize?: number }) => {
      const size = q.pageSize ?? 10_000;
      if (!q.onPage) return paged;
      for (let i = 0; i < paged.length; i += size) await q.onPage(paged.slice(i, i + size));
      return [];
    },
    client: {
      query: async ({ query }: { query: string }) => ({
        json: async () =>
          query.includes('FROM ad_spend')
            ? [
                {
                  platform: 'meta',
                  campaign_id: 'c1',
                  campaign_name: 'Spring',
                  cost: 100,
                  currency: 'DKK',
                  impressions: 10,
                  clicks: 5,
                  platform_conversions: 1,
                },
              ]
            : capped,
      }),
    },
  };
  return {
    principal: { workspaceId: 'ws_test' },
    tx: commandTx([{ event: 'Order Completed', value: 'total' }], gaps),
    services: { events },
  } as unknown as CommandContext;
};

describe('ads.performance conversion paging (#786)', () => {
  it('counts more conversion events than the old 100,000-row cap', async () => {
    const result = await adPerformance.handler({ since: '2026-01-01', until: '2026-01-10', windowDays: 30 }, context());
    expect(result.unattributed.conversions).toBe(CONVERSION_COUNT);
    expect(result.totals.conversions).toBe(0);
  });
});

describe('attribution timeouts (0.14.12 review round 5)', () => {
  it('recognises both the ClickHouse server deadline and the client request timeout', async () => {
    const { isAttributionTimeout } = await import('../src/spend');
    expect(isAttributionTimeout(new Error('Timeout exceeded: elapsed 30.1 seconds, maximum: 30. (TIMEOUT_EXCEEDED)'))).toBe(true);
    expect(isAttributionTimeout(new Error('Timeout error.'))).toBe(true);
    expect(isAttributionTimeout(new Error('Code: 241. Memory limit exceeded'))).toBe(false);
  });

  it('keeps the server deadline below the ClickHouse client request timeout (30 s by default)', async () => {
    const { ATTRIBUTION_LIMITS } = await import('../src/spend');
    expect(ATTRIBUTION_LIMITS.queryTimeoutSeconds).toBeLessThan(30);
  });
});

describe('spend import errors (0.14.16 review round 2)', () => {
  it('never turns an unexpected failure into a user-facing message', async () => {
    const { importSpendCommand } = await import('../src/spend');
    const { AppError } = await import('@agentic-marketing/core');
    const db = {
      withWorkspace: async () => {
        throw new Error('driver failure: password=probe-secret');
      },
      admin: {
        query: async () => {
          throw new Error('driver failure: password=probe-secret');
        },
      },
    };
    const ctx = { principal: { workspaceId: 'ws' }, services: { db, events: {}, keyProvider: {} } } as unknown as CommandContext;
    const err = await importSpendCommand.handler({ connection: `con_${'0'.repeat(32)}`, days: 3 }, ctx).catch((e: unknown) => e);
    // An unexpected error propagates as is, so the executor audits and answers it as a sanitised
    // internal failure; it must not become an AppError, whose message reaches the caller verbatim.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});

describe('provider error bodies (#885)', () => {
  // A platform (or a gateway in front of it) that echoes the request's credential must not have that
  // text copied into the AppError: this message reaches the caller, the audit log and the agent
  // ledger. Only the provider's own code and message may survive.
  const startProvider = async (status: number, body: string) => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };
  const egress = { allowedHosts: ['127.0.0.1'] };

  it('keeps Meta Insights to its own code and message, without the token', async () => {
    const { metaSpend } = await import('../src/spend');
    const provider = await startProvider(
      400,
      JSON.stringify({
        error: { code: 190, message: 'Invalid OAuth access token: access_token=probe-secret' },
        debug: { access_token: 'probe-secret' },
      }),
    );
    try {
      const conn = {
        connector: 'meta_ads',
        settings: { pixelId: '1234567890', adAccountId: '1234567890', apiBase: provider.base, apiVersion: 'v24.0' },
      } as never;
      const err = (await metaSpend(conn, { accessToken: 't'.repeat(30) }, '2026-01-01', '2026-01-02', egress).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toContain('Meta Insights answered 400');
      expect(err.message).toContain('190');
      expect(err.message).toContain('Invalid OAuth access token');
      expect(err.message).toContain('access_token=[redacted]');
      expect(err.message).not.toContain('probe-secret');
    } finally {
      await provider.close();
    }
  });

  it('keeps Google Ads to its own code and message, without the token', async () => {
    const { googleSpend } = await import('../src/spend');
    const provider = await startProvider(
      403,
      JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'developer-token=probe-secret is not authorised' } }),
    );
    try {
      const conn = {
        connector: 'google_ads',
        oauthStatus: 'connected',
        settings: { customerId: '1234567890', reportingBase: provider.base },
      } as never;
      const secrets = {
        clientId: 'client',
        clientSecret: 'secret',
        developerToken: 'd'.repeat(20),
        __oauth: { accessToken: 't'.repeat(30) },
      };
      const err = (await googleSpend(conn, secrets, '2026-01-01', '2026-01-02', egress).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toContain('Google Ads answered 403');
      expect(err.message).toContain('PERMISSION_DENIED');
      expect(err.message).not.toContain('probe-secret');
    } finally {
      await provider.close();
    }
  });

  it('never quotes a body that is not a JSON error object', async () => {
    const { metaSpend } = await import('../src/spend');
    const provider = await startProvider(502, 'access_token=probe-secret');
    try {
      const conn = {
        connector: 'meta_ads',
        settings: { pixelId: '1234567890', adAccountId: '1234567890', apiBase: provider.base, apiVersion: 'v24.0' },
      } as never;
      const err = (await metaSpend(conn, { accessToken: 't'.repeat(30) }, '2026-01-01', '2026-01-02', egress).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toBe('Meta Insights answered 502.');
      expect(err.message).not.toContain('probe-secret');
    } finally {
      await provider.close();
    }
  });
});

// #917: both spend reads stopped at 50 pages with no signal, so a large account's cost was silently
// short and CPA/ROAS were quietly wrong. The fetchers now say whether more pages remained.
describe('spend read truncation (#917)', () => {
  const startProvider = async (respond: (url: string, body: string, hits: number) => unknown) => {
    const { createServer } = await import('node:http');
    let hits = 0;
    const server = createServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        hits += 1;
        const payload = respond(req.url ?? '', body, hits);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch {
        failFakeServer(res);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return {
      base: `http://127.0.0.1:${port}`,
      hits: () => hits,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };
  const egress = { allowedHosts: ['127.0.0.1'] };
  const metaRow = {
    campaign_id: 'c1',
    campaign_name: 'Spring',
    spend: '10',
    impressions: '2',
    clicks: '1',
    date_start: '2026-01-02',
    account_currency: 'DKK',
  };
  const googleBody = {
    results: [
      {
        campaign: { id: '1', name: 'Search' },
        segments: { date: '2026-01-02' },
        metrics: { costMicros: '1000000', impressions: '5', clicks: '2', conversions: 1 },
        customer: { currencyCode: 'DKK' },
      },
    ],
    nextPageToken: 'more',
  };

  it('reports a complete Meta read as not truncated', async () => {
    const provider = await startProvider(() => ({ data: [metaRow] }));
    try {
      const conn = {
        connector: 'meta_ads',
        settings: { pixelId: '1234567890', adAccountId: '1234567890', apiBase: provider.base, apiVersion: 'v24.0' },
      } as never;
      const read = await metaSpend(conn, { accessToken: 't'.repeat(30) }, '2026-01-01', '2026-01-02', egress);
      expect(read.rows).toHaveLength(1);
      // The account identity the ad_spend rows carry; the gap key uses the same value.
      expect(read.account).toBe('act_1234567890');
      expect(read.truncated).toBe(false);
    } finally {
      await provider.close();
    }
  });

  it('reports Meta truncation at the page ceiling instead of stopping silently', async () => {
    let port = 0;
    const provider = await startProvider((_url, _body, hits) => ({
      data: [metaRow],
      paging: { next: `http://127.0.0.1:${port}/next?page=${hits}` },
    }));
    port = Number(new URL(provider.base).port);
    try {
      const { SPEND_LIMITS } = await import('../src/spend');
      const conn = {
        connector: 'meta_ads',
        settings: { pixelId: '1234567890', adAccountId: '1234567890', apiBase: provider.base, apiVersion: 'v24.0' },
      } as never;
      const read = await metaSpend(conn, { accessToken: 't'.repeat(30) }, '2026-01-01', '2026-01-02', egress);
      expect(read.truncated).toBe(true);
      expect(read.rows).toHaveLength(SPEND_LIMITS.metaPages);
      expect(provider.hits()).toBe(SPEND_LIMITS.metaPages);
    } finally {
      await provider.close();
    }
  });

  it('reports Google truncation at the page ceiling', async () => {
    const provider = await startProvider(() => googleBody);
    try {
      const { SPEND_LIMITS } = await import('../src/spend');
      const conn = {
        connector: 'google_ads',
        oauthStatus: 'connected',
        settings: { customerId: '1234567890', reportingBase: provider.base },
      } as never;
      const secrets = { clientId: 'c', clientSecret: 's', developerToken: 'd'.repeat(20), __oauth: { accessToken: 't'.repeat(30) } };
      const read = await googleSpend(conn, secrets, '2026-01-01', '2026-01-02', egress);
      expect(read.truncated).toBe(true);
      expect(read.rows).toHaveLength(SPEND_LIMITS.googlePages);
    } finally {
      await provider.close();
    }
  });

  it('reports a complete Google read as not truncated', async () => {
    const provider = await startProvider(() => ({ ...googleBody, nextPageToken: undefined }));
    try {
      const conn = {
        connector: 'google_ads',
        oauthStatus: 'connected',
        settings: { customerId: '1234567890', reportingBase: provider.base },
      } as never;
      const secrets = { clientId: 'c', clientSecret: 's', developerToken: 'd'.repeat(20), __oauth: { accessToken: 't'.repeat(30) } };
      const read = await googleSpend(conn, secrets, '2026-01-01', '2026-01-02', egress);
      expect(read.rows).toHaveLength(1);
      expect(read.account).toBe('1234567890');
      expect(read.truncated).toBe(false);
    } finally {
      await provider.close();
    }
  });

  it('only reports truncation for a stored range that overlaps the report', async () => {
    const { incompleteSpendFor } = await import('../src/spendState');
    const gap = (platform: 'meta' | 'google', account: string, from: string, to: string) => ({ platform, account, from, to });
    expect(
      incompleteSpendFor([gap('meta', 'act_1', '2025-12-01', '2026-01-31')], { since: '2026-01-01', until: '2026-01-10' }),
    ).toHaveLength(1);
    expect(incompleteSpendFor([gap('meta', 'act_1', '2025-10-01', '2025-10-31')], { since: '2026-01-01', until: '2026-01-10' })).toEqual(
      [],
    );
    expect(incompleteSpendFor([gap('meta', 'act_1', '2025-12-01', '2026-01-31')], { since: '2026-02-01', until: '2026-02-10' })).toEqual(
      [],
    );
    // A Meta-only report ignores a truncated Google import, and vice versa.
    expect(
      incompleteSpendFor([gap('google', '1234567890', '2026-01-01', '2026-01-10')], {
        since: '2026-01-01',
        until: '2026-01-10',
        platform: 'meta',
      }),
    ).toEqual([]);
    expect(
      incompleteSpendFor([gap('google', '1234567890', '2026-01-01', '2026-01-10')], {
        since: '2026-01-01',
        until: '2026-01-10',
        platform: 'google',
      }),
    ).toHaveLength(1);
  });
});

describe('ads.performance unattributed and unmatched (#917)', () => {
  const attributionContext = (opts: { spend: Record<string, unknown>[]; touch: string | null; gaps?: GapRow[] }) => {
    const conversions = [
      {
        profileId: '',
        anonymousId: 'anon-touch',
        userId: '',
        name: 'Order Completed',
        timestamp: Date.parse('2026-01-05T00:00:00.000Z'),
        properties: { total: 50 },
      },
      {
        profileId: '',
        anonymousId: '',
        userId: 'user-only',
        name: 'Order Completed',
        timestamp: Date.parse('2026-01-05T00:01:00.000Z'),
        properties: { total: 10 },
      },
    ];
    const events = {
      settingsFor: async () => ({}),
      conversionEvents: async (_ws: string, q: { onPage?: (rows: typeof conversions) => void | Promise<void> }) => {
        await q.onPage?.(conversions);
        return [];
      },
      client: {
        query: async ({ query }: { query: string }) => ({
          json: async () => {
            if (query.includes('FROM ad_spend')) return opts.spend;
            if (query.includes('count() AS n')) return [{ anonymous_id: 'anon-touch', n: 1 }];
            if (query.includes('argMax')) return opts.touch ? [{ idx: 0, campaign: opts.touch, source: 'facebook' }] : [];
            return [];
          },
        }),
      },
    };
    return {
      principal: { workspaceId: 'ws_test' },
      tx: commandTx([{ event: 'Order Completed', value: 'total' }], opts.gaps ?? []),
      services: { events },
    } as unknown as CommandContext;
  };
  const spend = [
    {
      platform: 'meta',
      campaign_id: 'spring',
      campaign_name: 'Spring',
      cost: 100,
      currency: 'DKK',
      impressions: 1,
      clicks: 1,
      platform_conversions: 1,
    },
  ];

  it('puts a conversion whose last touch names a campaign without spend in unmatched, not unattributed', async () => {
    const ctx = attributionContext({ spend, touch: 'Summer Sale' });
    const result = await adPerformance.handler({ since: '2026-01-01', until: '2026-01-10', windowDays: 30 }, ctx);
    expect(result.unmatched).toEqual({ conversions: 1, revenue: 50 });
    expect(result.unattributed).toEqual({ conversions: 1, revenue: 10 });
    expect(result.totals.conversions).toBe(0);
    expect(result.totals.revenue).toBe(0);
    expect(result.notes.join(' ')).toContain('matches no spend row');
  });

  it('attributes a touch that matches a spend row and leaves unmatched empty', async () => {
    const ctx = attributionContext({ spend, touch: 'Spring' });
    const result = await adPerformance.handler({ since: '2026-01-01', until: '2026-01-10', windowDays: 30 }, ctx);
    expect(result.campaigns[0]).toMatchObject({ campaignId: 'spring', conversions: 1, revenue: 50 });
    expect(result.unmatched).toEqual({ conversions: 0, revenue: 0 });
    expect(result.unattributed).toEqual({ conversions: 1, revenue: 10 });
    // totals are the campaign rows only.
    expect(result.totals.conversions).toBe(1);
    expect(result.totals.revenue).toBe(50);
  });

  it('marks spendTruncated for an incomplete range in the window and names the range', async () => {
    const ctx = attributionContext({
      spend,
      touch: 'Spring',
      gaps: [{ platform: 'meta', account: 'act_10001', fromDate: '2026-01-01', toDate: '2026-01-31' }],
    });
    const result = await adPerformance.handler({ since: '2026-01-01', until: '2026-01-10', windowDays: 30 }, ctx);
    expect(result.spendTruncated).toBe(true);
    expect(result.notes.join(' ')).toContain('meta act_10001 2026-01-01 to 2026-01-10');
    expect(result.notes.join(' ')).toContain('CPA is understated and ROAS is overstated');
  });

  it('does not warn for a report entirely outside the stored incomplete range', async () => {
    const ctx = attributionContext({
      spend,
      touch: 'Spring',
      gaps: [{ platform: 'meta', account: 'act_10001', fromDate: '2026-01-05', toDate: '2026-01-09' }],
    });
    const result = await adPerformance.handler({ since: '2026-02-01', until: '2026-02-10', windowDays: 30 }, ctx);
    expect(result.spendTruncated).toBe(false);
    expect(result.notes.join(' ')).not.toContain('incomplete');
  });
});

// #962: the raised Google Ads ceiling (50 pages × 10,000 rows) was read into one array, mapped into
// a second and inserted in a single ClickHouse call. The import now streams page by page into
// bounded chunks, and records the incomplete window before the first insert, so an OOM or crash
// later leaves the truncation warning instead of losing it with the insert.
describe('chunked spend import (#962)', () => {
  const startProvider = async (pages: number, rowsPerPage = 7) => {
    const { createServer } = await import('node:http');
    let hits = 0;
    const server = createServer(async (req, res) => {
      try {
        for await (const _chunk of req) {
          // Drain the request body; the query itself does not matter to the fake provider.
        }
        hits += 1;
        const results = Array.from({ length: rowsPerPage }, (_, i) => ({
          campaign: { id: String(hits * 100 + i), name: `Campaign ${hits}-${i}` },
          segments: { date: '2026-01-02' },
          metrics: { costMicros: '1000000', impressions: '5', clicks: '2', conversions: 1 },
          customer: { currencyCode: 'DKK' },
        }));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ results, ...(hits < pages ? { nextPageToken: `page-${hits + 1}` } : {}) }));
      } catch {
        failFakeServer(res);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return {
      base: `http://127.0.0.1:${port}`,
      hits: () => hits,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };
  const egress = { allowedHosts: ['127.0.0.1'] };
  const conn = (base: string) =>
    ({
      connector: 'google_ads',
      oauthStatus: 'connected',
      workspaceId: 'ws',
      settings: { customerId: '1234567890', reportingBase: base },
    }) as never;
  const secrets = { clientId: 'c', clientSecret: 's', developerToken: 'd'.repeat(20), __oauth: { accessToken: 't'.repeat(30) } };

  /** The smallest Db/Tx shape recordSpendGaps and its read-modify-write need. */
  const gapStore = () => {
    const gaps: { platform: string; account: string; fromDate: string; toDate: string }[] = [];
    const tx = {
      execute: async () => ({}),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === schema.adSpendGaps ? gaps.slice() : []),
        }),
      }),
      delete: (table: unknown) => ({
        where: async () => {
          if (table === schema.adSpendGaps) gaps.length = 0;
        },
      }),
      insert: (table: unknown) => ({
        values: async (values: typeof gaps) => {
          if (table === schema.adSpendGaps) gaps.push(...values);
        },
      }),
    };
    const db = { withWorkspace: async (_ws: string, fn: (t: unknown) => Promise<unknown>) => fn(tx) } as never;
    return { db, gaps };
  };

  it('inserts a many-page Google read in bounded chunks, with totals unchanged', async () => {
    const provider = await startProvider(3);
    const saved = { ...SPEND_LIMITS };
    try {
      SPEND_LIMITS.googlePages = 10;
      const { db, gaps } = gapStore();
      const inserts: number[] = [];
      const events = {
        client: {
          insert: async (payload: { values: unknown[] }) => {
            inserts.push(payload.values.length);
          },
        },
      } as never;
      const since = '2026-01-01';
      const until = '2026-01-31';
      const result = await storeSpendPages(
        { db, events, ws: 'ws', platform: 'google', since, until },
        (sink) => googleSpend(conn(provider.base), secrets, since, until, egress, sink),
        3,
      );
      expect(result).toMatchObject({ rows: 21, truncated: false });
      expect(provider.hits()).toBe(3);
      // No insert carries more than a bounded chunk (a page is split too), and every row arrived once.
      expect(inserts).toEqual([3, 3, 1, 3, 3, 1, 3, 3, 1]);
      expect(Math.max(...inserts)).toBeLessThanOrEqual(SPEND_INSERT_CHUNK_ROWS);
      expect(inserts.reduce((n, size) => n + size, 0)).toBe(21);
      // A complete read leaves no gap behind (the pre-insert warning is removed at the end).
      expect(gaps).toEqual([]);
    } finally {
      Object.assign(SPEND_LIMITS, saved);
      await provider.close();
    }
  });

  it('keeps the gap record when the read is truncated at the page ceiling', async () => {
    // Always another page: the import stops at its two-page ceiling with a truncated read.
    const provider = await startProvider(Number.POSITIVE_INFINITY);
    const saved = { ...SPEND_LIMITS };
    try {
      SPEND_LIMITS.googlePages = 2;
      const { db, gaps } = gapStore();
      const events = { client: { insert: async () => {} } } as never;
      const since = '2026-01-01';
      const until = '2026-01-31';
      const result = await storeSpendPages({ db, events, ws: 'ws', platform: 'google', since, until }, (sink) =>
        googleSpend(conn(provider.base), secrets, since, until, egress, sink),
      );
      expect(result).toMatchObject({ rows: 14, truncated: true });
      expect(gaps).toEqual([{ workspaceId: 'ws', platform: 'google', account: '1234567890', fromDate: since, toDate: until }]);
    } finally {
      Object.assign(SPEND_LIMITS, saved);
      await provider.close();
    }
  });

  it('records the gap before the first insert, so a crash mid-import cannot hide it', async () => {
    const provider = await startProvider(2);
    const saved = { ...SPEND_LIMITS };
    try {
      SPEND_LIMITS.googlePages = 10;
      const { db, gaps } = gapStore();
      let calls = 0;
      const events = {
        client: {
          insert: async () => {
            calls += 1;
            if (calls === 2) throw new Error('the api pod was killed');
          },
        },
      } as never;
      const since = '2026-01-01';
      const until = '2026-01-31';
      const err = await storeSpendPages({ db, events, ws: 'ws', platform: 'google', since, until }, (sink) =>
        googleSpend(conn(provider.base), secrets, since, until, egress, sink),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ platform: 'google', account: '1234567890', fromDate: since, toDate: until });
    } finally {
      Object.assign(SPEND_LIMITS, saved);
      await provider.close();
    }
  });
});

describe('spend gap clearing (#953)', () => {
  it('is a people-only write that targets one account', async () => {
    const { clearSpendGapsCommand } = await import('../src/spend');
    expect(clearSpendGapsCommand.humansOnly).toBe(true);
    expect(clearSpendGapsCommand.effect).toBe('write');
    expect(clearSpendGapsCommand.permission).toBe('artifacts:write');
    expect(clearSpendGapsCommand.input.parse({ platform: 'google', account: '1234567890' })).toEqual({
      platform: 'google',
      account: '1234567890',
    });
    expect(clearSpendGapsCommand.input.safeParse({ platform: 'microsoft', account: '1' }).success).toBe(false);
  });
});
