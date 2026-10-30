import {
  analyseHoldout,
  artifactTypes,
  type CampaignDefinition,
  holdoutHashVersion,
  publishedSingleton,
  publishValidators,
  referenceExtractors,
} from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type {} from '@agentic-marketing/events';
import { and, eq, gte, inArray, isNotNull, lte, max } from 'drizzle-orm';
import { z } from 'zod';

// Campaigns (#65) stay thin: a published campaign version groups existing artifacts under one goal
// and one UTM campaign. Membership is read from those published versions rather than from a join
// table: a workspace has few campaigns, and this keeps the artifact immutable and the write path
// unchanged. Evaluation and holdouts read campaigns through these helpers.

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
 * The published campaign whose control group applies to this sending member, if any. A campaign
 * without a control group does not affect its members; a journey or broadcast is a member of at
 * most one published campaign (the publish validator enforces that), so the first match is it.
 */
export async function campaignWithControlForMember(tx: Tx, artifactId: string): Promise<PublishedCampaign | undefined> {
  return (await publishedCampaigns(tx)).find((c) => !!c.content.controlGroup && c.content.members.some((m) => m.artifactId === artifactId));
}

/**
 * Publishing a campaign checks that its members exist and that no sending member already belongs to
 * another published campaign. Content (templates, segments, experiences, forms) may be shared.
 */
publishValidators.set('campaign', async (content, tx, artifact) => {
  const artifactId = artifact?.id;
  const c = content as CampaignDefinition;
  const problems: string[] = [];
  const ids = [...new Set(c.members.map((m) => m.artifactId))];
  const found = ids.length
    ? await tx
        .select({ id: schema.artifacts.id, type: schema.artifacts.type, name: schema.artifacts.name })
        .from(schema.artifacts)
        .where(inArray(schema.artifacts.id, ids))
    : [];
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

  if (c.controlGroup) {
    // A changed percentage is a new campaign scope. Refuse it once people are assigned unless the
    // content explicitly starts a new scope; assignments under the old version stay, so the result
    // never mixes two randomisations.
    if (artifactId && !c.controlGroup.reset) {
      const hashVersion = holdoutHashVersion(c.controlGroup.percent);
      const scope = and(
        eq(schema.holdoutAssignments.workspaceId, artifact.workspaceId),
        eq(schema.holdoutAssignments.scopeType, 'campaign'),
        eq(schema.holdoutAssignments.scopeId, artifact.id),
      );
      const [any] = await tx
        .select({ hashVersion: schema.holdoutAssignments.hashVersion })
        .from(schema.holdoutAssignments)
        .where(scope)
        .limit(1);
      if (any) {
        const [current] = await tx
          .select({ hashVersion: schema.holdoutAssignments.hashVersion })
          .from(schema.holdoutAssignments)
          .where(and(scope, eq(schema.holdoutAssignments.hashVersion, hashVersion)))
          .limit(1);
        if (!current)
          problems.push(
            'The control group percentage changed after people were assigned. Set controlGroup.reset: true to start a new scope; people already assigned keep their old arm, and reports count only the new scope.',
          );
      }
    }
    // One scope only: a journey member's own holdout would randomise people a second time inside
    // the campaign's. Check the draft and the live version, since either can be what members run.
    const journeyIds = ids.filter((id) => byId.get(id)?.type === 'journey');
    if (journeyIds.length) {
      const versions = await tx
        .select({
          id: schema.artifacts.id,
          name: schema.artifacts.name,
          latestVersion: schema.artifacts.latestVersion,
          publishedVersion: schema.artifacts.publishedVersion,
          number: schema.artifactVersions.number,
          content: schema.artifactVersions.content,
        })
        .from(schema.artifacts)
        .innerJoin(
          schema.artifactVersions,
          and(
            eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
            eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          ),
        )
        .where(and(inArray(schema.artifacts.id, journeyIds), eq(schema.artifacts.type, 'journey')));
      const flagged = new Set<string>();
      for (const v of versions) {
        if (v.number !== v.latestVersion && v.number !== v.publishedVersion) continue;
        if (flagged.has(v.id) || !(v.content as { controlGroup?: unknown }).controlGroup) continue;
        flagged.add(v.id);
        problems.push(
          `“${v.name}” (${v.id}) is a journey with its own controlGroup, but this campaign has one too. Use only one scope: remove the journey’s controlGroup (it inherits the campaign’s) or the campaign’s.`,
        );
      }
    }
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

export const campaignHoldoutResult = defineCommand({
  name: 'campaigns.holdoutResult',
  title: 'Campaign uplift against its control group',
  description:
    "Per arm (control, treatment): people assigned, people who did the campaign goal within the attribution window after their assignment, conversion rate, revenue per currency and e-mail unsubscribes. Reports absolute and relative lift, Newcombe's 95% interval for the difference of proportions, whether the minimum sample size is met in both arms, and a verdict. Verdicts other than not_enough_data need both samples and an interval that excludes zero. The campaign's control group covers every sending member.",
  input: z.object({
    campaignId: CampaignId,
    from: isoDateTime('from').optional().describe('Count assignments at or after this time'),
    to: isoDateTime('to').optional().describe('Count assignments and goal events at or before this time'),
  }),
  output: z.object({
    campaignId: z.string(),
    goal: z.object({
      kind: z.enum(['conversion', 'revenue', 'engagement', 'signups', 'custom']),
      event: z.string().nullable(),
      attributionDays: z.number().int(),
    }),
    controlGroup: z
      .object({ percent: z.number(), minSampleSize: z.number(), hashVersion: z.string() })
      .describe('The live scope and its hash version'),
    from: z.string().nullable(),
    to: z.string().nullable(),
    control: z.object({
      entered: z.number().int(),
      converted: z.number().int(),
      unsubscribed: z.number().int().describe('E-mail unsubscribes among the campaign’s sends, the guardrail'),
      conversionRate: z.number(),
      unsubscribeRate: z.number(),
      revenue: z.record(z.string(), z.number()).describe('Revenue per currency, from the conversion map'),
    }),
    treatment: z.object({
      entered: z.number().int(),
      converted: z.number().int(),
      unsubscribed: z.number().int().describe('E-mail unsubscribes among the campaign’s sends, the guardrail'),
      conversionRate: z.number(),
      unsubscribeRate: z.number(),
      revenue: z.record(z.string(), z.number()).describe('Revenue per currency, from the conversion map'),
    }),
    absoluteLift: z.number().describe('Treatment conversion rate minus control'),
    relativeLift: z.number().nullable().describe('Absolute lift divided by the control rate; null when control never converted'),
    ci95: z.tuple([z.number(), z.number()]).nullable().describe("Newcombe's 95% interval for the difference of proportions"),
    minSampleSizeMet: z.boolean(),
    verdict: z.enum(['not_enough_data', 'no_clear_difference', 'treatment_better', 'treatment_worse']),
    note: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.campaignId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [a] = await ctx.tx
      .select({ type: schema.artifacts.type, publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, input.campaignId));
    if (a?.type !== 'campaign') throw new AppError('not_found', `No campaign ${input.campaignId}.`);
    if (!a.publishedVersion)
      throw new AppError('not_found', `Campaign ${input.campaignId} has no published version; publish it before measuring uplift.`);
    const [row] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, input.campaignId), eq(schema.artifactVersions.number, a.publishedVersion)));
    const c = artifactTypes.campaign.content.parse(row!.content) as CampaignDefinition;
    const cg = c.controlGroup;
    if (!cg)
      throw new AppError(
        'invalid_input',
        'This campaign has no control group. Set controlGroup {percent} and publish it to measure uplift.',
      );
    if (!c.goal.event)
      throw new AppError(
        'invalid_input',
        'The campaign goal has no event, so there is nothing to count as a conversion. Set goal.event and publish it before measuring uplift.',
      );

    const hashVersion = holdoutHashVersion(cg.percent);
    const from = input.from ? new Date(input.from) : undefined;
    const to = input.to ? new Date(input.to) : undefined;
    const assignments = await ctx.tx
      .select({
        profileId: schema.holdoutAssignments.profileId,
        arm: schema.holdoutAssignments.arm,
        assignedAt: schema.holdoutAssignments.assignedAt,
      })
      .from(schema.holdoutAssignments)
      .where(
        and(
          eq(schema.holdoutAssignments.workspaceId, ws),
          eq(schema.holdoutAssignments.scopeType, 'campaign'),
          eq(schema.holdoutAssignments.scopeId, input.campaignId),
          eq(schema.holdoutAssignments.hashVersion, hashVersion),
          from ? gte(schema.holdoutAssignments.assignedAt, from) : undefined,
          to ? lte(schema.holdoutAssignments.assignedAt, to) : undefined,
        ),
      );
    const counts = {
      control: { entered: 0, converted: 0, unsubscribed: 0 },
      treatment: { entered: 0, converted: 0, unsubscribed: 0 },
    };
    const revenue: Record<'control' | 'treatment', Record<string, number>> = { control: {}, treatment: {} };
    const people = new Map<string, { arm: 'control' | 'treatment'; assignedAt: Date }>();
    for (const r of assignments) {
      counts[r.arm].entered++;
      people.set(r.profileId, { arm: r.arm, assignedAt: r.assignedAt });
    }

    // Goal events and revenue, when there are people to measure. ClickHouse joins in code to the
    // Postgres assignments: a person counts once, and only events inside their own attribution
    // window count, so a re-assignment after a reset cannot borrow an older conversion.
    const sends = c.members.length
      ? await ctx.tx
          .select({ id: schema.artifacts.id, type: schema.artifacts.type })
          .from(schema.artifacts)
          .where(
            inArray(
              schema.artifacts.id,
              c.members.map((m) => m.artifactId),
            ),
          )
      : [];
    const sendingIds = sends.filter((s) => SENDING_TYPES.has(s.type)).map((s) => s.id);
    const names =
      c.goal.kind === 'revenue'
        ? [...new Set(((await publishedSingleton(ctx.tx, 'conversion_map'))?.rules ?? []).map((r) => r.event))]
        : [c.goal.event!];
    if (people.size && names.length) {
      const assignedTimes = [...people.values()].map((p) => p.assignedAt.getTime());
      const first = new Date(Math.min(...assignedTimes));
      const last = new Date(Math.max(...assignedTimes) + c.goal.attributionDays * 86_400_000);
      const windowTo = to && to < last ? to : last;
      const identifiers = await ctx.tx
        .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
        .from(schema.identifiers)
        .where(
          and(inArray(schema.identifiers.profileId, [...people.keys()]), inArray(schema.identifiers.type, ['anonymous_id', 'user_id'])),
        );
      const profileOf = new Map(identifiers.map((i) => [i.value, i.profileId]));
      const events = await ctx.services.events.conversionEvents(ws, { names, from: first, to: windowTo });
      const conversions = new Map<string, { timestamp: number; name: string; properties: Record<string, unknown> }[]>();
      for (const e of events) {
        const profileId = profileOf.get(e.userId) ?? profileOf.get(e.anonymousId);
        if (!profileId) continue;
        const list = conversions.get(profileId) ?? [];
        list.push(e);
        conversions.set(profileId, list);
      }
      if (c.goal.kind === 'revenue') {
        const map = await publishedSingleton(ctx.tx, 'conversion_map');
        const rules = new Map<string, NonNullable<typeof map>['rules'][number]>();
        for (const rule of map?.rules ?? []) if (!rules.has(rule.event)) rules.set(rule.event, rule);
        for (const [profileId, person] of people) {
          const end = Math.min(person.assignedAt.getTime() + c.goal.attributionDays * 86_400_000, windowTo.getTime());
          let converted = false;
          for (const e of conversions.get(profileId) ?? []) {
            if (e.timestamp < person.assignedAt.getTime() || e.timestamp > end) continue;
            if (!converted) {
              counts[person.arm].converted++;
              converted = true;
            }
            const rule = rules.get(e.name);
            const value = rule?.value ? numericProperty(e.properties, rule.value) : 0;
            const currency =
              rule?.currency ??
              (rule?.currencyProperty ? String(stringProperty(e.properties, rule.currencyProperty) ?? '').toUpperCase() : '') ??
              '';
            const code = currency || 'UNKNOWN';
            revenue[person.arm][code] = (revenue[person.arm][code] ?? 0) + value;
          }
        }
      } else {
        for (const [profileId, person] of people) {
          const end = Math.min(person.assignedAt.getTime() + c.goal.attributionDays * 86_400_000, windowTo.getTime());
          if ((conversions.get(profileId) ?? []).some((e) => e.timestamp >= person.assignedAt.getTime() && e.timestamp <= end))
            counts[person.arm].converted++;
        }
      }
      // The guardrail covers the campaign's own sends only: messages from unrelated journeys or
      // broadcasts are not the campaign's doing.
      const unsubscribed = sendingIds.length
        ? new Set(await ctx.services.events.unsubscribedProfiles(ws, { journeyIds: sendingIds, from, to }))
        : new Set<string>();
      for (const [profileId, person] of people) if (unsubscribed.has(profileId)) counts[person.arm].unsubscribed++;
    }

    const analysis = analyseHoldout(counts.control, counts.treatment, cg.minSampleSize);
    const note =
      analysis.verdict === 'not_enough_data'
        ? `Need at least ${cg.minSampleSize} people in each arm; ${counts.control.entered} control and ${counts.treatment.entered} treatment so far.`
        : analysis.verdict === 'no_clear_difference'
          ? 'The 95% interval for the difference includes zero, so the campaign has not shown a clear effect yet.'
          : analysis.verdict === 'treatment_better'
            ? 'Treatment converted at a higher rate and the 95% interval excludes zero; the campaign looks incremental.'
            : 'Treatment converted at a lower rate and the 95% interval excludes zero; the campaign looks harmful.';
    return {
      campaignId: input.campaignId,
      goal: { kind: c.goal.kind, event: c.goal.event ?? null, attributionDays: c.goal.attributionDays },
      controlGroup: { percent: cg.percent, minSampleSize: cg.minSampleSize, hashVersion },
      from: input.from ?? null,
      to: input.to ?? null,
      control: { ...analysis.control, revenue: revenue.control },
      treatment: { ...analysis.treatment, revenue: revenue.treatment },
      absoluteLift: analysis.absoluteLift,
      relativeLift: analysis.relativeLift,
      ci95: analysis.ci95,
      minSampleSizeMet: analysis.minSampleSizeMet,
      verdict: analysis.verdict,
      note,
    };
  },
});

/** A numeric property at a dotted path, as the conversion map names it. Missing or invalid is 0. */
function numericProperty(properties: Record<string, unknown>, path: string): number {
  const v = stringProperty(properties, path);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A property at a dotted path, from JSON that may hold numbers or strings. */
function stringProperty(properties: Record<string, unknown>, path: string): unknown {
  let v: unknown = properties;
  for (const key of path.split('.').filter(Boolean)) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

export const archiveCampaign = defineCommand({
  name: 'campaigns.archive',
  title: 'Archive a campaign',
  description:
    'Stop treating a campaign as live without touching its members: they keep their content, versions and sends. An archived campaign no longer answers campaigns.of or supplies a shared UTM campaign.',
  input: z.object({ campaignId: CampaignId }),
  output: z.object({ campaignId: z.string(), archived: z.literal(true), memberIds: z.array(z.string()) }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'content.publish',
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

export const campaignCommands = [campaignsOf, campaignMembers, campaignHoldoutResult, archiveCampaign] as const;
