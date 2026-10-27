import type { Tx } from '@agentic-marketing/db';
import { publishedCampaigns } from './campaigns';

// Shared UTM campaign (#65): a broadcast or journey in a published campaign inherits its
// utmCampaign, unless the template sets utm.campaign itself (explicit beats inherited). The send
// worker resolves this once per delivery batch, not once per message: the first miss loads every
// published campaign and fills the map with all members, including the misses (null).

export type CampaignUtmCache = Map<string, string | null>;

/** The utm_campaign a member inherits from its published campaign, or null. Caches per send batch. */
export async function campaignUtmCampaign(tx: Tx, memberId: string, cache: CampaignUtmCache = new Map()): Promise<string | null> {
  if (cache.has(memberId)) return cache.get(memberId) ?? null;
  for (const c of await publishedCampaigns(tx)) {
    const value = c.content.utmCampaign ?? null;
    for (const m of c.content.members) if (!cache.has(m.artifactId)) cache.set(m.artifactId, value);
  }
  if (!cache.has(memberId)) cache.set(memberId, null);
  return cache.get(memberId) ?? null;
}
