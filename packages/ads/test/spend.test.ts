import type { CommandContext } from '@agentic-marketing/commands';
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
