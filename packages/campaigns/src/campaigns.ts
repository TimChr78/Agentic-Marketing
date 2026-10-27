import { artifactTypes, type CampaignDefinition, publishValidators, referenceExtractors } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray, isNotNull, max } from 'drizzle-orm';
import { z } from 'zod';

// Campaigns (#65) stay thin: a published campaign version groups existing artifacts under one goal
// and one UTM campaign. Membership is read from those published versions rather than from a join
// table: a workspace has few campaigns, and this keeps the artifact immutable and the write path
// unchanged. Later evaluation and holdouts read campaigns through these helpers.

const CampaignId = z.string().regex(/^cmp_[0-9a-f]{32}$/, 'A campaign id (cmp_…)');
const MemberRole = z.enum(['primary', 'follow_up', 'content']);
const Goal = z.object({
  kind: z.enum(['conversion', 'revenue', 'engagement', 'signups', 'custom']),
  event: z.string().nullable(),
  target: z.number().nullable(),
  attributionDays: z.number().int(),
});

/** The types a campaign may name, by artifact type. Ids carry the type prefix; the type itself is checked on publish. */
const MEMBER_TYPES = new Set(['broadcast', 'journey', 'email_template', 'sms_template', 'push_template', 'experience', 'form', 'segment']);
/** Members that actually send; these may belong to only one published campaign. */
const SENDING_TYPES = new Set(['broadcast', 'journey']);

export interface PublishedCampaign {
  id: string;
  name: string;
  version: number;
  content: CampaignDefinition;
}

/**
 * Every published, non-archived campaign with the content of its published version. RLS scopes it
 * to the workspace of the transaction. Archived campaigns are not live, so they are left out of
 * lookups; their members stay untouched.
 */
export async function publishedCampaigns(tx: Tx): Promise<PublishedCampaign[]> {
  const rows = await tx
    .select({
      id: schema.artifacts.id,
      name: schema.artifacts.name,
      version: schema.artifacts.publishedVersion,
      content: schema.artifactVersions.content,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(and(eq(schema.artifacts.type, 'campaign'), isNotNull(schema.artifacts.publishedVersion), eq(schema.artifacts.archived, false)));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version!,
    content: artifactTypes.campaign.content.parse(r.content) as CampaignDefinition,
  }));
}

/**
 * The member ids of a campaign's published version, in the order the campaign lists them. Empty
 * when the campaign has never been published. Later tasks (evaluation, holdouts) use this.
 */
export async function campaignMemberIds(tx: Tx, campaignId: string): Promise<string[]> {
  const [row] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .leftJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(and(eq(schema.artifacts.id, campaignId), eq(schema.artifacts.type, 'campaign')));
  if (!row?.content) return [];
  return (artifactTypes.campaign.content.parse(row.content) as CampaignDefinition).members.map((m) => m.artifactId);
}

/**
 * Publishing a campaign checks that its members exist and that no sending member already belongs to
 * another published campaign. Content (templates, segments, experiences, forms) may be shared.
 */
publishValidators.set('campaign', async (content, tx, artifactId) => {
  const c = content as CampaignDefinition;
  const problems: string[] = [];
  const ids = [...new Set(c.members.map((m) => m.artifactId))];
  if (!ids.length) return problems;
  const found = await tx
    .select({ id: schema.artifacts.id, type: schema.artifacts.type, name: schema.artifacts.name })
    .from(schema.artifacts)
    .where(inArray(schema.artifacts.id, ids));
  const byId = new Map(found.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) problems.push(`${id} does not exist in this workspace`);
    else if (!MEMBER_TYPES.has(a.type)) problems.push(`“${a.name}” (${id}) is a ${a.type}, which cannot be a campaign member`);
  }
  // A campaign's own published version is not a conflict with itself when it is republished.
  const published = (await publishedCampaigns(tx)).filter((p) => p.id !== artifactId);
  for (const m of c.members) {
    const a = byId.get(m.artifactId);
    if (!a || !SENDING_TYPES.has(a.type)) continue;
    const owner = published.find((p) => p.content.members.some((x) => x.artifactId === m.artifactId));
    if (owner)
      problems.push(
        `“${a.name}” (${m.artifactId}) already belongs to the published campaign “${owner.name}” (${owner.id}); a sending member can be in only one published campaign so attribution stays unambiguous`,
      );
  }
  return problems;
});

// artifacts.get shows what a campaign refers to, and bundles publish members before the campaign.
referenceExtractors.set('campaign', (content) => ((content as CampaignDefinition).members ?? []).map((m) => m.artifactId));

export const campaignsOf = defineCommand({
  name: 'campaigns.of',
  title: 'Campaigns an artifact belongs to',
  description:
    'The published campaigns that list this broadcast, journey, template, experience, form or segment as a member, with the member’s role and the campaign goal and UTM campaign. Empty when it belongs to none.',
  input: z.object({ artifactId: z.string().regex(/^[a-z]{2,5}_[0-9a-f]{32}$/, 'An artifact id') }),
  output: z.object({
    campaigns: z.array(z.object({ id: z.string(), name: z.string(), role: MemberRole, goal: Goal, utmCampaign: z.string().nullable() })),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => ({
    campaigns: (await publishedCampaigns(ctx.tx)).flatMap((c) => {
      const member = c.content.members.find((m) => m.artifactId === input.artifactId);
      if (!member) return [];
      return [
        {
          id: c.id,
          name: c.name,
          role: member.role,
          goal: {
            kind: c.content.goal.kind,
            event: c.content.goal.event ?? null,
            target: c.content.goal.target ?? null,
            attributionDays: c.content.goal.attributionDays,
          },
          utmCampaign: c.content.utmCampaign ?? null,
        },
      ];
    }),
  }),
});

export const campaignMembers = defineCommand({
  name: 'campaigns.members',
  title: 'Campaign members',
  description:
    'The members of a campaign’s published version (or its latest draft when it has never been published), with name, type, whether each is published or a draft, and the last send or run for sending members.',
  input: z.object({ campaignId: CampaignId }),
  output: z.object({
    campaignId: z.string(),
    version: z.number().int(),
    published: z.boolean(),
    members: z.array(
      z.object({
        artifactId: z.string(),
        name: z.string(),
        type: z.string(),
        role: MemberRole,
        status: z.enum(['published', 'draft']),
        lastSendAt: z.string().nullable().describe('Last broadcast run or journey activity; null for content or before the first run'),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [campaign] = await ctx.tx
      .select({ latestVersion: schema.artifacts.latestVersion, publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, input.campaignId), eq(schema.artifacts.type, 'campaign')));
    if (!campaign) throw new AppError('not_found', `Campaign ${input.campaignId} does not exist in this workspace.`);
    const version = campaign.publishedVersion ?? campaign.latestVersion;
    const [row] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, input.campaignId), eq(schema.artifactVersions.number, version)));
    const def = artifactTypes.campaign.content.parse(row!.content) as CampaignDefinition;
    const ids = def.members.map((m) => m.artifactId);
    const artifacts = ids.length
      ? await ctx.tx
          .select({
            id: schema.artifacts.id,
            name: schema.artifacts.name,
            type: schema.artifacts.type,
            publishedVersion: schema.artifacts.publishedVersion,
          })
          .from(schema.artifacts)
          .where(inArray(schema.artifacts.id, ids))
      : [];
    const byId = new Map(artifacts.map((a) => [a.id, a]));

    // A broadcast has one run row and a journey's activity is indexed by (workspace, journey, profile),
    // so both are cheap even next to a large messages table.
    const broadcastIds = artifacts.filter((a) => a.type === 'broadcast').map((a) => a.id);
    const runs = broadcastIds.length
      ? await ctx.tx
          .select({
            broadcastId: schema.broadcastRuns.broadcastId,
            sendAt: schema.broadcastRuns.sendAt,
            startedAt: schema.broadcastRuns.startedAt,
            finishedAt: schema.broadcastRuns.finishedAt,
          })
          .from(schema.broadcastRuns)
          .where(inArray(schema.broadcastRuns.broadcastId, broadcastIds))
      : [];
    const lastSend = new Map(runs.map((r) => [r.broadcastId, (r.finishedAt ?? r.startedAt ?? r.sendAt).toISOString()]));
    const journeyIds = artifacts.filter((a) => a.type === 'journey').map((a) => a.id);
    const journeyRuns = journeyIds.length
      ? await ctx.tx
          .select({ journeyId: schema.journeyParticipants.journeyId, at: max(schema.journeyParticipants.updatedAt) })
          .from(schema.journeyParticipants)
          .where(inArray(schema.journeyParticipants.journeyId, journeyIds))
          .groupBy(schema.journeyParticipants.journeyId)
      : [];
    for (const r of journeyRuns) if (r.at) lastSend.set(r.journeyId, r.at.toISOString());

    return {
      campaignId: input.campaignId,
      version,
      published: campaign.publishedVersion !== null,
      members: def.members.flatMap((m) => {
        const a = byId.get(m.artifactId);
        if (!a) return [];
        return [
          {
            artifactId: a.id,
            name: a.name,
            type: a.type,
            role: m.role,
            status: a.publishedVersion !== null ? ('published' as const) : ('draft' as const),
            lastSendAt: lastSend.get(a.id) ?? null,
          },
        ];
      }),
    };
  },
});

export const archiveCampaign = defineCommand({
  name: 'campaigns.archive',
  title: 'Archive a campaign',
  description:
    'Stop treating a campaign as live without touching its members: they keep their content, versions and sends. An archived campaign no longer answers campaigns.of or supplies a shared UTM campaign.',
  input: z.object({ campaignId: CampaignId }),
  output: z.object({ campaignId: z.string(), archived: z.literal(true), memberIds: z.array(z.string()) }),
  permission: 'artifacts:write',
  effect: 'write',
  target: (i) => i.campaignId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx
      .select({ type: schema.artifacts.type })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, input.campaignId), eq(schema.artifacts.type, 'campaign')));
    if (!a) throw new AppError('not_found', `Campaign ${input.campaignId} does not exist in this workspace.`);
    const memberIds = await latestMemberIds(ctx.tx, input.campaignId);
    await ctx.tx
      .update(schema.artifacts)
      .set({ archived: true, updatedAt: new Date() })
      .where(and(eq(schema.artifacts.id, input.campaignId), eq(schema.artifacts.type, 'campaign')));
    return { campaignId: input.campaignId, archived: true as const, memberIds };
  },
});

/** Membership for archiving: the latest version, so a campaign archived before its first publish still answers. */
async function latestMemberIds(tx: Tx, campaignId: string): Promise<string[]> {
  const [row] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
      ),
    )
    .where(and(eq(schema.artifacts.id, campaignId), eq(schema.artifacts.type, 'campaign')));
  return row ? (artifactTypes.campaign.content.parse(row.content) as CampaignDefinition).members.map((m) => m.artifactId) : [];
}

export const campaignCommands = [campaignsOf, campaignMembers, archiveCampaign] as const;
