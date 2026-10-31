import {
  artifactTypeEnum,
  artifactTypes,
  type CampaignBrief,
  createArtifact,
  publishValidators,
  referenceExtractors,
} from '@agentic-marketing/artifacts';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

// Campaign agent (#64): a person approves a campaign_brief, and the agent turns it into draft
// artifacts. The plan is deterministic: it maps typed brief fields to skeletons, so the marketer
// can review the intent before any artifact exists and nothing is guessed by a model. The agent
// fills the copy; people still publish.

const BriefId = z.string().regex(/^cpb_[0-9a-f]{32}$/, 'A campaign brief id (cpb_…)');
const DraftRef = (key: string) => `@draft:${key}`;
const REF = /^@draft:([a-z_]+)$/;

/** A draft the plan proposes. Content may name a sibling as @draft:<key>; fromBrief resolves it. */
export const CampaignPlanDraft = z.object({
  key: z.string().describe('A stable key for this draft within the plan, e.g. "email_template"'),
  type: artifactTypeEnum,
  name: z.string(),
  content: z.unknown(),
  dependsOn: z.array(z.string()).describe('Keys that must be created first; their ids replace @draft:<key>'),
  note: z.string().optional().describe('What the agent should fill or check, when the brief does not determine it'),
});
export type CampaignPlanDraft = z.output<typeof CampaignPlanDraft>;

export const CampaignPlan = z.object({
  briefId: z.string(),
  briefVersion: z.number().int(),
  name: z.string(),
  goal: z.object({
    measure: z.string().describe('The metric-layer measure the plan intends to move'),
    kind: z.enum(['conversion', 'revenue', 'engagement', 'signups', 'custom']),
    event: z.string().nullable().describe('The event that counts as the goal; null when the goal has none'),
    target: z.number(),
    direction: z.enum(['up', 'down']),
    attributionDays: z.number().int(),
  }),
  holdout: z.object({ percent: z.number(), minSampleSize: z.number() }).nullable(),
  drafts: z.array(CampaignPlanDraft),
  notes: z.array(z.string()).describe('Where a deterministic mapping is not meaningful, and what a person or the agent must decide'),
  warnings: z.array(z.string()),
});
export type CampaignPlan = z.output<typeof CampaignPlan>;

const channelPurpose = (channel: 'email' | 'sms' | 'push') =>
  channel === 'email' ? 'marketing_email' : channel === 'sms' ? 'marketing_sms' : 'marketing_push';

/** A URL-safe utm_campaign from the brief name, deterministic and within the schema's bounds. */
function slug(text: string): string {
  const value = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return value || 'campaign';
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The skeleton for one channel's template. The agent replaces the seed copy with real content. */
function templateDraft(channel: 'email' | 'sms' | 'push', purpose: string, message: string, briefName: string): CampaignPlanDraft {
  const key = `${channel}_template`;
  if (channel === 'email') {
    const body = escapeHtml(clip(message, 4000));
    return {
      key,
      type: 'email_template',
      name: clip(`${briefName} e-mail`, 120),
      dependsOn: [],
      note: 'The subject and body are seeded from message.key. Replace them with the real copy, check tone and language, and preview with templates.preview.',
      content: {
        purpose,
        subject: clip(message, 120),
        mjml: `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`,
      },
    };
  }
  if (channel === 'sms') {
    return {
      key,
      type: 'sms_template',
      name: clip(`${briefName} SMS`, 120),
      dependsOn: [],
      note: 'Seeded from message.key. Keep the text short, check the cost and segments with smsTemplates.preview.',
      content: { purpose, body: clip(message, 600) },
    };
  }
  return {
    key,
    type: 'push_template',
    name: clip(`${briefName} push`, 120),
    dependsOn: [],
    note: 'Seeded from message.key. Replace it with the real title and body and set the link before publishing.',
    content: { purpose, title: clip(message, 80), body: clip(message, 200) },
  };
}

/**
 * Pure, deterministic mapping from an approved brief to the artifact skeletons it implies. No
 * database access beyond what the caller has already read, so tests and agents see the same plan
 * every time for the same brief version.
 */
export function buildCampaignPlan(brief: CampaignBrief, briefId: string, briefVersion: number, name: string): CampaignPlan {
  const notes: string[] = [];
  const warnings: string[] = [...brief.warnings];
  const drafts: CampaignPlanDraft[] = [];
  const channels = brief.channels;

  // Audience: use one named segment as-is; combine several; create one from consent when none is named.
  let segmentRef: string;
  if (brief.audience.segmentIds.length === 1) {
    segmentRef = brief.audience.segmentIds[0]!;
    notes.push(`Uses the existing segment ${segmentRef}; it must stay published for the campaign to run.`);
  } else {
    const key = 'segment';
    const condition =
      brief.audience.segmentIds.length > 1
        ? { all: brief.audience.segmentIds.map((segment) => ({ segment })) }
        : { consent: channels[0]!.purpose ?? channelPurpose(channels[0]!.channel) };
    drafts.push({
      key,
      type: 'segment',
      name: clip(`${name} audience`, 120),
      dependsOn: [],
      note:
        brief.audience.segmentIds.length > 1
          ? 'Combines the segments named in the brief. Adjust it if the audience should be narrower.'
          : 'No segment was named, so the plan seeds one from consent to the first channel purpose. Refine the condition to match audience.description before publishing.',
      content: { description: clip(brief.audience.description, 1000), mode: 'dynamic', condition },
    });
    segmentRef = DraftRef(key);
    if (brief.audience.segmentIds.length === 0)
      warnings.push(
        'The audience is described in words; the created segment uses a consent condition as a placeholder. Check it with segments.preview before publishing.',
      );
    else notes.push('Combines several named segments with all(...); check the overlap with segments.preview.');
  }

  // One template per channel; the agent fills the copy.
  for (const channel of channels) {
    const purpose = channel.purpose ?? channelPurpose(channel.channel);
    drafts.push(templateDraft(channel.channel, purpose, brief.message.key, name));
    if (!channel.purpose)
      notes.push(`The ${channel.channel} template uses the default purpose ${purpose}; change it if another purpose applies.`);
  }

  const starters = channels.map((c) => `${c.channel}_template`);
  const oneOff = brief.schedule.mode === 'once';
  let sendingKeys: { key: string; role: 'primary' | 'follow_up' }[];

  if (oneOff) {
    // A one-off campaign is one broadcast per channel, all at the brief's sendAt.
    sendingKeys = channels.map((channel, index) => {
      const key = channels.length === 1 ? 'broadcast' : `broadcast_${channel.channel}`;
      drafts.push({
        key,
        type: 'broadcast',
        name: clip(channels.length === 1 ? `${name} send` : `${name} ${channel.channel}`, 120),
        dependsOn: [`${channel.channel}_template`, ...(segmentRef.startsWith('@draft:') ? [segmentRef.slice(7)] : [])],
        note:
          channels.length > 1
            ? 'One broadcast per channel at the same sendAt. Move one in the editor if the channels should be staggered.'
            : 'Sets the brief sendAt. Check the audience and would-send count with broadcasts.preview.',
        content: {
          template: DraftRef(`${channel.channel}_template`),
          segment: segmentRef,
          ...(brief.schedule.sendAt ? { sendAt: brief.schedule.sendAt } : {}),
          description: clip(brief.objective, 500),
        },
      });
      return { key, role: index === 0 ? ('primary' as const) : ('follow_up' as const) };
    });
  } else {
    // A journey for a series: trigger, then each channel with a wait between steps.
    const triggerId = 'trigger';
    const exitId = 'exit';
    const nodes: Record<string, unknown>[] = [
      {
        id: triggerId,
        kind: 'trigger',
        label: 'Enter',
        config: brief.audience.entryEvent
          ? { event: brief.audience.entryEvent, reentry: 'once' }
          : { segment: segmentRef, reentry: 'once' },
      },
    ];
    channels.forEach((channel, index) => {
      if (index > 0)
        nodes.push({
          id: `wait_${index}`,
          kind: 'wait',
          label: 'Wait',
          config: { duration: brief.schedule.waitBetweenSteps },
        });
      nodes.push({
        id: channel.channel,
        kind: channel.channel,
        label: channel.channel,
        config: { template: DraftRef(`${channel.channel}_template`) },
      });
    });
    nodes.push({ id: exitId, kind: 'exit', label: 'Done', config: {} });
    drafts.push({
      key: 'journey',
      type: 'journey',
      name: clip(`${name} journey`, 120),
      dependsOn: [...starters, ...(segmentRef.startsWith('@draft:') ? [segmentRef.slice(7)] : [])],
      note: brief.audience.entryEvent
        ? 'Enters on the brief event; each channel follows with the brief wait. Simulate it with journeys.simulate.'
        : 'Enters when someone joins the audience segment; each channel follows with the brief wait. Simulate it with journeys.simulate.',
      content: {
        purpose: channels[0]!.purpose ?? channelPurpose(channels[0]!.channel),
        ...(brief.goal.event ? { goal: brief.goal.event } : {}),
        nodes,
      },
    });
    sendingKeys = [{ key: 'journey', role: 'primary' }];
    if (brief.schedule.sendAt)
      notes.push(
        'A journey starts when someone enters; sendAt is kept as the campaign startsAt for the calendar and does not delay the trigger.',
      );
  }

  // The campaign ties the members together and carries the one control group.
  const memberRefs: { artifactId: string; role: 'primary' | 'follow_up' | 'content' }[] = [];
  for (const channel of channels) memberRefs.push({ artifactId: DraftRef(`${channel.channel}_template`), role: 'content' });
  memberRefs.push({ artifactId: segmentRef, role: 'content' });
  for (const sending of sendingKeys) memberRefs.push({ artifactId: DraftRef(sending.key), role: sending.role });
  drafts.push({
    key: 'campaign',
    type: 'campaign',
    name: clip(`${name} campaign`, 120),
    dependsOn: [...starters, ...sendingKeys.map((s) => s.key), ...(segmentRef.startsWith('@draft:') ? [segmentRef.slice(7)] : [])],
    note: 'The control group lives on the campaign so every sending member shares one assignment; do not add one to a journey member.',
    content: {
      description: clip(brief.objective, 1000),
      briefId,
      briefVersion,
      goal: {
        kind: brief.goal.kind,
        ...(brief.goal.event ? { event: brief.goal.event } : {}),
        target: brief.goal.target,
        attributionDays: brief.goal.attributionDays,
      },
      utmCampaign: slug(name),
      ...(brief.holdout ? { controlGroup: { percent: brief.holdout.percent, minSampleSize: brief.holdout.minSampleSize } } : {}),
      members: memberRefs,
      ...(brief.schedule.sendAt ? { startsAt: brief.schedule.sendAt } : {}),
    },
  });

  if (brief.holdout)
    notes.push(
      `The campaign holds out ${brief.holdout.percent}% (at least ${brief.holdout.minSampleSize} per arm). Read uplift with campaigns.holdoutResult; it needs goal.event, which this brief ${brief.goal.event ? 'has' : 'does not have'}.`,
    );
  if (brief.offer)
    notes.push(
      `Offer “${brief.offer.description}” (source: ${brief.offer.source}) is not created as an artifact; point the copy at the real voucher pool or system.`,
    );
  if (Object.keys(brief.guardrails).length)
    notes.push(
      'Guardrails are carried by the brief and enforced by the mandate and delivery policy; no artifact encodes them. Check them against workspace.autonomy before publishing.',
    );
  if (brief.message.tone || brief.message.language)
    notes.push('Tone and language guide the copy; the artifacts carry the result, not these labels.');
  notes.push(
    'The plan is deterministic: it maps the brief to skeletons and does not write the final copy or choose creative. The agent fills content, then people publish the bundle.',
  );
  notes.push(
    'A draft that depends on another names it as @draft:<key>. Create in dependsOn order and replace each reference with the created id, or call campaigns.fromBrief, which does both.',
  );
  if (!brief.audience.entryEvent && oneOff)
    notes.push(
      'The broadcast audience is the segment as it is at send time; use a snapshot segment if it must not change before the send.',
    );

  return {
    briefId,
    briefVersion,
    name,
    goal: {
      measure: brief.goal.measure,
      kind: brief.goal.kind,
      event: brief.goal.event ?? null,
      target: brief.goal.target,
      direction: brief.goal.direction,
      attributionDays: brief.goal.attributionDays,
    },
    holdout: brief.holdout ? { percent: brief.holdout.percent, minSampleSize: brief.holdout.minSampleSize } : null,
    drafts,
    notes,
    warnings,
  };
}

/** The approved (published) version of a campaign brief, or a clear refusal. */
async function approvedBrief(ctx: CommandContext, briefId: string) {
  const [artifact] = await ctx.tx
    .select({ id: schema.artifacts.id, name: schema.artifacts.name, publishedVersion: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, briefId), eq(schema.artifacts.type, 'campaign_brief')));
  if (!artifact) throw new AppError('not_found', `Campaign brief ${briefId} does not exist in this workspace.`);
  if (!artifact.publishedVersion)
    throw new AppError(
      'conflict',
      `Campaign brief “${artifact.name}” (${briefId}) has no published version. A person must approve it before a plan is built from it; the agent cannot approve its own brief.`,
    );
  const [version] = await ctx.tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
        eq(schema.artifactVersions.artifactId, briefId),
        eq(schema.artifactVersions.number, artifact.publishedVersion),
      ),
    );
  if (!version) throw new AppError('not_found', `Version ${artifact.publishedVersion} of campaign brief ${briefId} does not exist.`);
  const brief = artifactTypes.campaign_brief.content.parse(version.content) as CampaignBrief;
  return { artifact, version: artifact.publishedVersion, brief };
}

export const planCampaign = defineCommand({
  name: 'campaigns.plan',
  title: 'Plan a campaign from an approved brief',
  description:
    'Read an approved (published) campaign_brief and return the draft bundle it implies: the segment to use or create, one template per channel, a broadcast per channel or a journey, and the campaign that links them with the control group the brief asks for. Deterministic: it maps brief fields to skeletons and lists in notes where a deterministic mapping is not meaningful, so the agent can fill the copy and a person can review the intent before anything is written. Nothing is created.',
  input: z.object({ briefId: BriefId }),
  output: CampaignPlan,
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.briefId,
  handler: async (input, ctx) => {
    const { artifact, version, brief } = await approvedBrief(ctx, input.briefId);
    return buildCampaignPlan(brief, input.briefId, version, artifact.name);
  },
});

/** Replaces @draft:<key> strings with the ids created so far. */
function resolveRefs(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') {
    const match = REF.exec(value);
    return match ? (ids.get(match[1]!) ?? value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, ids));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveRefs(item, ids)]));
  return value;
}

export const campaignFromBrief = defineCommand({
  name: 'campaigns.fromBrief',
  title: 'Create draft artifacts from an approved brief',
  description:
    'Create the draft artifacts of campaigns.plan for an approved (published) campaign_brief, with references resolved to the ids just created (templates before sends, everything before the campaign). Returns the ids. Never publishes: a person still approves the bundle with artifacts.requestPublishBundle. Refuses an unapproved brief.',
  input: z.object({ briefId: BriefId }),
  output: z.object({
    briefId: z.string(),
    briefVersion: z.number().int(),
    campaignId: z.string(),
    artifacts: z
      .array(z.object({ key: z.string(), artifactId: z.string(), type: z.string(), name: z.string(), state: z.literal('draft') }))
      .describe('In creation order'),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.briefId,
  handler: async (input, ctx) => {
    const { artifact, version, brief } = await approvedBrief(ctx, input.briefId);
    const plan = buildCampaignPlan(brief, input.briefId, version, artifact.name);
    const ids = new Map<string, string>();
    const created: { key: string; artifactId: string; type: string; name: string; state: 'draft' }[] = [];
    for (const draft of plan.drafts) {
      const content = resolveRefs(draft.content, ids);
      const result = await createArtifact.handler(
        {
          type: draft.type,
          name: draft.name,
          content,
          note: `From approved campaign brief “${artifact.name}” (${input.briefId} v${version})`,
        },
        ctx,
      );
      ids.set(draft.key, result.artifactId);
      created.push({ key: draft.key, artifactId: result.artifactId, type: draft.type, name: draft.name, state: 'draft' });
    }
    const campaign = created.find((item) => item.key === 'campaign');
    if (!campaign) throw new AppError('invalid_input', 'The plan did not produce a campaign draft.');
    return { briefId: input.briefId, briefVersion: version, campaignId: campaign.artifactId, artifacts: created };
  },
});

/**
 * Publishing a brief is the approval gate. The schema already requires the fields; these checks
 * cover what needs the workspace: a resolvable published audience and a send in the future.
 */
publishValidators.set('campaign_brief', async (content, tx) => {
  const parsed = artifactTypes.campaign_brief.content.safeParse(content);
  if (!parsed.success) return [];
  const brief = parsed.data;
  const problems: string[] = [];
  if (!brief.objective.trim()) problems.push('a campaign brief needs an objective');
  if (!brief.goal.measure.trim()) problems.push('a campaign brief needs the metric-layer measure it intends to move');
  if (brief.schedule.sendAt && Date.parse(brief.schedule.sendAt) <= Date.now())
    problems.push('the schedule is in the past; a campaign must start in the future');
  const segmentIds = [...new Set(brief.audience.segmentIds)];
  if (segmentIds.length) {
    const found = await tx
      .select({
        id: schema.artifacts.id,
        type: schema.artifacts.type,
        name: schema.artifacts.name,
        publishedVersion: schema.artifacts.publishedVersion,
      })
      .from(schema.artifacts)
      .where(inArray(schema.artifacts.id, segmentIds));
    const byId = new Map(found.map((row) => [row.id, row]));
    for (const id of segmentIds) {
      const segment = byId.get(id);
      if (!segment) problems.push(`segment ${id} does not exist in this workspace`);
      else if (segment.type !== 'segment') problems.push(`“${segment.name}” (${id}) is a ${segment.type}, not a segment`);
      else if (!segment.publishedVersion)
        problems.push(`segment “${segment.name}” (${id}) is not published; publish the audience before approving the brief`);
    }
  }
  return problems;
});

referenceExtractors.set('campaign_brief', (content) => {
  const parsed = artifactTypes.campaign_brief.content.safeParse(content);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.audience.segmentIds)];
});
