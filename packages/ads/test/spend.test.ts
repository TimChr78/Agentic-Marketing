import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { adPerformance } from '../src/spend';

// #786: ads.performance used to read conversion events with a raw `LIMIT 100000` and no order,
// paging or truncation signal, so a busy window silently lost conversions, revenue, CPA and ROAS.
// It now pages through the shared events.conversionEvents helper (#366), which walks the whole
// window by (timestamp, event_id). This fake store returns more than the old cap: every event must
// reach the attribution loop, without inserting 100,000 rows into ClickHouse.
const OLD_CAP = 100_000;
const CONVERSION_COUNT = OLD_CAP + 1;

/** The smallest tx shape publishedSingleton's conversion-map lookup uses. */
const conversionMapTx = (rules: { event: string; value?: string }[]) =>
  ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => [{ content: { rules } }],
        }),
      }),
    }),
  }) as never;

const context = (): CommandContext => {
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
    tx: conversionMapTx([{ event: 'Order Completed', value: 'total' }]),
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
