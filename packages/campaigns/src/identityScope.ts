import { artifactTypes, type CampaignDefinition, holdoutHashVersion } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { type IdentityMap, identityScopeProfileLimit, loadIdentityMap, overLimitIdentityMap } from './identity';

// One campaign identity map for every surface (#590). The headline and the member rows used to
// scope the map to the campaign's sent recipients, while the campaign-wide holdout scoped it to its
// assignments. Near the map bound that made one side drop resolution and the other keep it, so a
// conversion stored under a merged-away profile counted in the headline but not in the holdout.
//
// The scope here is the union of both sets, the bound is decided once on that union, and every
// caller ships the same map or the same over-limit note. This lives in @agentic-marketing/campaigns
// because analytics already depends on campaigns; campaigns cannot import analytics.

export interface CampaignIdentityWindow {
  /** Campaign ids whose holdout assignments belong to the map. */
  campaignIds: readonly string[];
  /** The campaign's sending member ids (broadcasts and journeys). */
  memberIds: readonly string[];
  /** The measurement window; omitted means every send for those members. */
  from?: string;
  to?: string;
}

type Deps = {
  tx: Tx;
  events: Pick<EventStore, 'client' | 'settingsFor'>;
  workspaceId: string;
};

/** The profile ids the campaign sent or delivered to in the window, capped at bound + 1. */
async function sentProfileIds(deps: Deps, scope: CampaignIdentityWindow, limit: number): Promise<string[] | null> {
  if (!scope.memberIds.length) return [];
  const conditions = [
    `workspace_id = {ws:UUID}`,
    `journey_id IN {members:Array(String)}`,
    ...(scope.from ? [`at >= {from:DateTime64(3, 'UTC')}`] : []),
    ...(scope.to ? [`at <= {to:DateTime64(3, 'UTC')}`] : []),
    `type IN ('sent', 'delivered')`,
    `profile_id != ''`,
  ];
  const result = await deps.events.client.query({
    query: `SELECT DISTINCT profile_id FROM message_events FINAL
            WHERE ${conditions.join(' AND ')}
            LIMIT {limit:UInt32}`,
    query_params: {
      ws: deps.workspaceId,
      members: [...scope.memberIds],
      ...(scope.from ? { from: scope.from.replace('Z', '') } : {}),
      ...(scope.to ? { to: scope.to.replace('Z', '') } : {}),
      limit: limit + 1,
    },
    format: 'JSONEachRow',
    clickhouse_settings: { ...(await deps.events.settingsFor(deps.workspaceId)), max_execution_time: 10 } as never,
  });
  const rows = await result.json<{ profile_id: string }>();
  const ids = [...new Set(rows.map((row) => row.profile_id).filter(Boolean))];
  return ids.length > limit ? null : ids;
}

/**
 * Each published campaign's current holdout hash version. A percentage reset starts a new scope and
 * keeps the old assignments, which `campaigns.holdoutResult` no longer counts; campaigns without a
 * published control group have no counted assignments at all.
 */
async function currentHashVersions(deps: Deps, campaignIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await deps.tx
    .select({ id: schema.artifacts.id, content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(and(eq(schema.artifacts.workspaceId, deps.workspaceId), inArray(schema.artifacts.id, [...campaignIds])));
  const versions = new Map<string, string>();
  for (const row of rows) {
    const parsed = artifactTypes.campaign.content.safeParse(row.content);
    const percent = parsed.success ? (parsed.data as CampaignDefinition).controlGroup?.percent : undefined;
    if (percent !== undefined) versions.set(row.id, holdoutHashVersion(percent));
  }
  return versions;
}

/**
 * The profile ids assigned to the campaign's holdout in the window, both arms, capped at bound + 1.
 * The filters are the ones `campaigns.holdoutResult` applies: the window on `assigned_at` (0.14.5
 * review round 4) and the published campaign's current hash version (round 5), so assignments the
 * report does not count cannot push its scope over the bound.
 */
async function assignedProfileIds(deps: Deps, scope: CampaignIdentityWindow, limit: number): Promise<string[] | null> {
  if (!scope.campaignIds.length) return [];
  const versions = await currentHashVersions(deps, scope.campaignIds);
  if (!versions.size) return [];
  const current = [...versions].map(([campaignId, hashVersion]) =>
    and(eq(schema.holdoutAssignments.scopeId, campaignId), eq(schema.holdoutAssignments.hashVersion, hashVersion)),
  );
  const rows = await deps.tx
    .selectDistinct({ profileId: schema.holdoutAssignments.profileId })
    .from(schema.holdoutAssignments)
    .where(
      and(
        eq(schema.holdoutAssignments.workspaceId, deps.workspaceId),
        eq(schema.holdoutAssignments.scopeType, 'campaign'),
        or(...current),
        scope.from ? gte(schema.holdoutAssignments.assignedAt, new Date(scope.from)) : undefined,
        scope.to ? lte(schema.holdoutAssignments.assignedAt, new Date(scope.to)) : undefined,
      ),
    )
    .limit(limit + 1);
  if (rows.length > limit) return null;
  return rows.map((row) => row.profileId).filter(Boolean);
}

/**
 * The campaign's one identity map: the sent recipients in the window unioned with the holdout
 * assignments. Above the scope bound, or above the map's own pair/byte bound, every caller gets the
 * over-limit map and reports the same note instead of shipping a partial or a different map.
 */
export async function campaignIdentityMap(
  deps: Deps,
  scope: CampaignIdentityWindow,
  limit = identityScopeProfileLimit(),
): Promise<IdentityMap> {
  const [sent, assigned] = await Promise.all([sentProfileIds(deps, scope, limit), assignedProfileIds(deps, scope, limit)]);
  if (sent === null || assigned === null) return overLimitIdentityMap();
  const union = new Set(sent);
  for (const id of assigned) union.add(id);
  // Each part was capped separately so a part over the bound is detected without a huge read; the
  // union still needs its own check because two under-bound parts can add up past it.
  if (union.size > limit) return overLimitIdentityMap();
  return loadIdentityMap(deps.tx, deps.workspaceId, { profileIds: [...union] });
}
