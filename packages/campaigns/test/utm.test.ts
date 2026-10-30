import type { Tx } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { publishedCampaigns } from '../src/campaigns';
import { type CampaignUtmCache, campaignUtmCampaign } from '../src/utm';

// packages/campaigns/src/utm.ts resolves the UTM campaign a member inherits; it never builds a
// URL. The link tagging itself (query strings, fragments, existing utm_* parameters) lives in the
// e-mail package and is unit-tested in packages/email/test/links.test.ts.

const id = (prefix: string, char: string) => `${prefix}_${char.repeat(32)}`;
const BROADCAST = id('bct', 'a');
const JOURNEY = id('jrn', 'b');
const SHARED = id('bct', 'c');

/** A transaction whose published-campaign lookup returns fixed rows and counts how often it ran. */
function fakeTx(rows: unknown[], onQuery?: () => void): Tx {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => {
            onQuery?.();
            return rows;
          },
        }),
      }),
    }),
  } as unknown as Tx;
}

function campaignRow(campaignId: string, utmCampaign: string | undefined, members: string[]) {
  return {
    id: campaignId,
    name: `Campaign ${campaignId}`,
    version: 2,
    content: {
      goal: { kind: 'signups' },
      ...(utmCampaign ? { utmCampaign } : {}),
      members: members.map((artifactId) => ({ artifactId, role: 'primary' })),
    },
  };
}

describe('published campaigns', () => {
  it('parses each published version into campaign content with the schema defaults', async () => {
    const [campaign] = await publishedCampaigns(fakeTx([campaignRow(id('cmp', 'a'), 'autumn', [BROADCAST])]));
    expect(campaign).toMatchObject({ id: id('cmp', 'a'), name: `Campaign ${id('cmp', 'a')}`, version: 2 });
    expect(campaign?.content).toMatchObject({
      goal: { kind: 'signups', attributionDays: 7 },
      utmCampaign: 'autumn',
      members: [{ artifactId: BROADCAST, role: 'primary' }],
    });
  });

  it('rejects stored content that no longer satisfies the campaign schema', async () => {
    const invalid = {
      id: id('cmp', 'b'),
      name: 'Broken',
      version: 1,
      content: { goal: { kind: 'conversion' } },
    };
    await expect(publishedCampaigns(fakeTx([invalid]))).rejects.toThrow();
  });
});

describe('shared UTM campaign', () => {
  it('inherits the utm_campaign of the published campaign that lists the member', async () => {
    const tx = fakeTx([campaignRow(id('cmp', 'a'), 'autumn', [BROADCAST, JOURNEY])]);
    await expect(campaignUtmCampaign(tx, BROADCAST)).resolves.toBe('autumn');
    await expect(campaignUtmCampaign(tx, JOURNEY)).resolves.toBe('autumn');
  });

  it('returns null for a member no published campaign names, and caches the miss', async () => {
    let queries = 0;
    const tx = fakeTx([campaignRow(id('cmp', 'a'), 'autumn', [BROADCAST])], () => queries++);
    const cache: CampaignUtmCache = new Map();

    await expect(campaignUtmCampaign(tx, JOURNEY, cache)).resolves.toBeNull();
    expect(cache.get(JOURNEY)).toBeNull();
    await expect(campaignUtmCampaign(tx, JOURNEY, cache)).resolves.toBeNull();
    expect(queries).toBe(1);
  });

  it('loads every published campaign once and fills the cache for members and misses alike', async () => {
    let queries = 0;
    const tx = fakeTx(
      [campaignRow(id('cmp', 'a'), 'autumn', [BROADCAST]), campaignRow(id('cmp', 'b'), 'winter', [JOURNEY])],
      () => queries++,
    );
    const cache: CampaignUtmCache = new Map();

    await campaignUtmCampaign(tx, SHARED, cache);

    expect(queries).toBe(1);
    expect(cache.get(BROADCAST)).toBe('autumn');
    expect(cache.get(JOURNEY)).toBe('winter');
    expect(cache.get(SHARED)).toBeNull();
  });

  it('keeps a value already in the batch cache, so an explicit setting wins', async () => {
    let queries = 0;
    const tx = fakeTx([campaignRow(id('cmp', 'a'), 'autumn', [BROADCAST])], () => queries++);
    const cache: CampaignUtmCache = new Map([[BROADCAST, 'explicit']]);

    await expect(campaignUtmCampaign(tx, BROADCAST, cache)).resolves.toBe('explicit');
    expect(queries).toBe(0);
  });

  it('keeps the first campaign when a member appears twice, matching the first match elsewhere', async () => {
    const tx = fakeTx([campaignRow(id('cmp', 'a'), 'autumn', [SHARED]), campaignRow(id('cmp', 'b'), 'winter', [SHARED])]);
    const cache: CampaignUtmCache = new Map();

    await expect(campaignUtmCampaign(tx, SHARED, cache)).resolves.toBe('autumn');
    expect(cache.get(SHARED)).toBe('autumn');
  });

  it('returns null for a campaign that sets no utm_campaign', async () => {
    const tx = fakeTx([campaignRow(id('cmp', 'a'), undefined, [BROADCAST])]);
    await expect(campaignUtmCampaign(tx, BROADCAST)).resolves.toBeNull();
  });
});
