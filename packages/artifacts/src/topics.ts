import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type ContentTopicSignal, type ContentTopicStatus, schema } from '@agentic-marketing/db';
import { and, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createArtifact, publishHooks } from './commands';
import { artifactTypes, publishValidators, referenceExtractors } from './types';

// The editorial topic backlog (#141). A topic is a row, not an artifact: it is a queue entry that
// moves through statuses, while its brief is a versioned content_brief artifact with the normal
// approval flow. The topic only stores the brief id and the published URL, so an archived topic
// keeps both. Content-item ids in signals and sources are plain strings: the content library
// (#140) owns its own table and this module must not depend on it.

const TopicId = z
  .string()
  .regex(/^ctp_[0-9a-f]{32}$/, 'A content topic id (ctp_…)')
  .describe('Content topic id, e.g. "ctp_0192…"');

export const CONTENT_TOPIC_STATUSES = ['idea', 'scored', 'brief', 'approved', 'drafting', 'published', 'archived'] as const;
const Status = z.enum(CONTENT_TOPIC_STATUSES);

const Signal = z.object({
  kind: z
    .enum(['content_item', 'community', 'manual', 'past_post'])
    .describe('content_item: from the library (#140); community: Reddit/HN demand; manual: a person’s idea; past_post: an earlier post'),
  id: z.string().max(200).optional().describe('Content item id, thread id or post id; a plain string, not a foreign key'),
  title: z.string().max(500).optional(),
  url: z.string().url().max(2000).optional(),
  relevance: z.enum(['high', 'medium', 'low']).optional(),
  comments: z.number().int().min(0).max(1_000_000).optional().describe('Community comments or upvotes, for the “why it surfaced” line'),
  weight: z.number().min(-100).max(100).default(5).describe('Points this signal adds to the score (5 by default)'),
});

const TargetDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD')
  .describe('Target publish date, YYYY-MM-DD');

const CampaignRef = z.string().regex(/^cmp_[0-9a-f]{32}$/, 'A campaign id (cmp_…)');
const BroadcastRef = z.string().regex(/^bct_[0-9a-f]{32}$/, 'A broadcast id (bct_…)');

const Topic = z.object({
  id: z.string(),
  title: z.string(),
  angle: z.string(),
  audience: z.string(),
  readerRole: z.string(),
  keyword: z.string().nullable(),
  tags: z.array(z.string()),
  status: Status,
  score: z.number().int(),
  signals: z.array(Signal),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  targetDate: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  campaignId: z.string().nullable(),
  broadcastId: z.string().nullable(),
  dedupeKey: z.string(),
  similarTopicIds: z.array(z.string()),
  briefArtifactId: z.string().nullable(),
  createdBy: z.object({ type: z.enum(['user', 'agent']), id: z.string() }),
  agentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type TopicRow = typeof schema.contentTopics.$inferSelect;

function toTopic(row: TopicRow) {
  return {
    id: row.id,
    title: row.title,
    angle: row.angle,
    audience: row.audience,
    readerRole: row.readerRole,
    keyword: row.keyword,
    tags: row.tags,
    status: row.status,
    score: row.score,
    signals: row.signals,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    targetDate: row.targetDate,
    canonicalUrl: row.canonicalUrl,
    campaignId: row.campaignId,
    broadcastId: row.broadcastId,
    dedupeKey: row.dedupeKey,
    similarTopicIds: row.similarTopicIds,
    briefArtifactId: row.briefArtifactId,
    createdBy: { type: row.createdByType, id: row.createdById },
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadTopic(ctx: CommandContext, id: string) {
  const [row] = await ctx.tx
    .select()
    .from(schema.contentTopics)
    .where(and(eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId), eq(schema.contentTopics.id, id)));
  if (!row) throw new AppError('not_found', `Topic ${id} does not exist in this workspace.`);
  return row;
}

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normaliseTopicText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The dedupe key: the normalised title plus the normalised keyword, when a keyword is set. */
export function topicDedupeKey(title: string, keyword?: string | null): string {
  const k = normaliseTopicText(keyword);
  return k ? `${normaliseTopicText(title)}|${k}` : normaliseTopicText(title);
}

/** A score from the signals: their weights added up, clamped to 0–100. */
export function scoreFromSignals(signals: ContentTopicSignal[]): number {
  const total = signals.reduce((sum, signal) => sum + (signal.weight ?? 5), 0);
  return Math.max(0, Math.min(100, Math.round(total)));
}

/** Agents may propose and score topics, but approving, publishing and assigning are people's calls. */
function assertAgentMayWrite(ctx: CommandContext, what: string) {
  if (ctx.principal.type === 'agent')
    throw new AppError('forbidden', `Only a person can ${what}. Agents may propose, score and draft topics and briefs.`);
}

/** Statuses an agent may set directly; brief approval and publication go through the brief. */
const AGENT_STATUSES: readonly ContentTopicStatus[] = ['idea', 'scored', 'drafting'];

function checkStatusForAgent(ctx: CommandContext, status: ContentTopicStatus | undefined) {
  if (ctx.principal.type === 'agent' && status && !AGENT_STATUSES.includes(status))
    throw new AppError(
      'forbidden',
      `An agent cannot set a topic to “${status}”. Approving and publishing go through the brief’s approval flow, and only a person assigns or archives.`,
    );
}

export const listContentTopics = defineCommand({
  name: 'content.topics.list',
  title: 'List the editorial backlog',
  description:
    'The workspace’s topics with status, score, signals, owner, target date, brief and published URL. Filter by status, owner, tag and score range; archived topics are left out unless asked for. This is a queue, not a calendar.',
  input: z.object({
    status: Status.optional().describe('Only this status; omit for every status except archived'),
    includeArchived: z.boolean().default(false).describe('Also show archived topics when no status filter is set'),
    owner: z.string().max(200).optional().describe('Owner id or owner name'),
    tag: z.string().max(100).optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScore: z.number().int().min(0).max(100).optional(),
    targetBefore: TargetDate.optional().describe('Topics with a target date on or before this day'),
    targetAfter: TargetDate.optional().describe('Topics with a target date on or after this day'),
    limit: z.number().int().min(1).max(500).default(200),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({ topics: z.array(Topic), count: z.number().int() }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  handler: async (input, ctx) => {
    const conditions = [
      input.status
        ? eq(schema.contentTopics.status, input.status)
        : input.includeArchived
          ? undefined
          : ne(schema.contentTopics.status, 'archived'),
      input.owner ? or(eq(schema.contentTopics.ownerId, input.owner), eq(schema.contentTopics.ownerName, input.owner)) : undefined,
      input.tag ? sql`${input.tag} = ANY(${schema.contentTopics.tags})` : undefined,
      input.minScore !== undefined ? gte(schema.contentTopics.score, input.minScore) : undefined,
      input.maxScore !== undefined ? lte(schema.contentTopics.score, input.maxScore) : undefined,
      input.targetBefore ? lte(schema.contentTopics.targetDate, input.targetBefore) : undefined,
      input.targetAfter ? gte(schema.contentTopics.targetDate, input.targetAfter) : undefined,
    ];
    const rows = await ctx.tx
      .select()
      .from(schema.contentTopics)
      .where(and(...conditions))
      .orderBy(desc(schema.contentTopics.score), desc(schema.contentTopics.updatedAt))
      .limit(input.limit)
      .offset(input.offset);
    return { topics: rows.map(toTopic), count: rows.length };
  },
});

export const createContentTopic = defineCommand({
  name: 'content.topics.create',
  title: 'Create a topic',
  description:
    'Add a topic to the editorial backlog, manually or from signals (content items, community demand, a past post). A new topic starts as idea, or scored when it has a score or signals. Near-duplicates are never silently created: the result names the existing topic and links both ways. Agents may propose topics; only people assign an owner or set approval/publication statuses.',
  input: z.object({
    title: z.string().min(1).max(200),
    angle: z.string().max(2000).default('').describe('One line on the angle, not the whole brief'),
    audience: z.string().max(2000).default(''),
    readerRole: z.string().max(200).default(''),
    keyword: z.string().max(200).optional().describe('Primary keyword or intent'),
    tags: z.array(z.string().min(1).max(100)).max(30).default([]),
    status: Status.optional().describe(
      'Defaults to idea, or scored when a score or signals are given; agents may only set idea, scored or drafting',
    ),
    score: z.number().int().min(0).max(100).optional().describe('Defaults to the sum of the signal weights'),
    signals: z.array(Signal).max(100).default([]),
    ownerId: z.string().max(200).optional(),
    ownerName: z.string().max(200).optional(),
    targetDate: TargetDate.optional(),
    canonicalUrl: z.string().url().max(2000).optional(),
    campaignId: CampaignRef.optional(),
    broadcastId: BroadcastRef.optional(),
    similarTopicIds: z.array(z.string()).max(50).default([]).describe('Other topics a person considers similar'),
  }),
  output: z.object({
    topic: Topic,
    duplicateOf: z
      .object({ id: z.string(), title: z.string() })
      .nullable()
      .describe('An existing near-duplicate by normalised title/keyword; the new topic links to it and it links back'),
    warnings: z.array(z.string()),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.title,
  handler: async (input, ctx) => {
    if (ctx.principal.type === 'agent' && (input.ownerId !== undefined || input.ownerName !== undefined))
      assertAgentMayWrite(ctx, 'assign a topic owner');
    checkStatusForAgent(ctx, input.status);
    const status: ContentTopicStatus = input.status ?? (input.signals.length || input.score !== undefined ? 'scored' : 'idea');
    if (status === 'published' && !input.canonicalUrl)
      throw new AppError('invalid_input', 'A topic can only be published with a canonical URL.');
    if (status === 'brief' || status === 'approved' || status === 'published' || status === 'archived')
      assertAgentMayWrite(ctx, `create a topic as ${status}`);

    const dedupeKey = topicDedupeKey(input.title, input.keyword);
    const [existing] = await ctx.tx
      .select({ id: schema.contentTopics.id, title: schema.contentTopics.title })
      .from(schema.contentTopics)
      .where(
        and(
          eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId),
          eq(schema.contentTopics.dedupeKey, dedupeKey),
          ne(schema.contentTopics.status, 'archived'),
        ),
      )
      .orderBy(desc(schema.contentTopics.createdAt))
      .limit(1);

    const id = newId('ctp');
    const similar = [...new Set([...(existing ? [existing.id] : []), ...input.similarTopicIds.filter((t) => t !== id)])];
    const [row] = await ctx.tx
      .insert(schema.contentTopics)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id,
        title: input.title,
        angle: input.angle,
        audience: input.audience,
        readerRole: input.readerRole,
        keyword: input.keyword ?? null,
        tags: input.tags,
        status,
        score: input.score ?? scoreFromSignals(input.signals),
        signals: input.signals,
        ownerId: input.ownerId ?? null,
        ownerName: input.ownerName ?? null,
        targetDate: input.targetDate ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        campaignId: input.campaignId ?? null,
        broadcastId: input.broadcastId ?? null,
        dedupeKey,
        similarTopicIds: similar,
        createdByType: ctx.principal.type,
        createdById: ctx.principal.userId,
        agentId: ctx.principal.agent?.id ?? null,
      })
      .returning();

    if (existing)
      await ctx.tx
        .update(schema.contentTopics)
        .set({ similarTopicIds: sql`array_append(${schema.contentTopics.similarTopicIds}, ${id})`, updatedAt: new Date() })
        .where(
          and(
            eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId),
            eq(schema.contentTopics.id, existing.id),
            sql`NOT (${id} = ANY(${schema.contentTopics.similarTopicIds}))`,
          ),
        );

    return {
      topic: toTopic(row),
      duplicateOf: existing ?? null,
      warnings: existing ? [`Similar to existing topic “${existing.title}” (${existing.id}); the topics are linked.`] : [],
    };
  },
});

export const updateContentTopic = defineCommand({
  name: 'content.topics.update',
  title: 'Update a topic',
  description:
    'Change a topic’s title, angle, audience, keyword, tags, target date, campaign/broadcast link or status. Marking it published requires a canonical URL. People set approval and publication and assign an owner; agents may edit the brief-adjacent fields and move within idea/scored/drafting.',
  input: z.object({
    topicId: TopicId,
    title: z.string().min(1).max(200).optional(),
    angle: z.string().max(2000).optional(),
    audience: z.string().max(2000).optional(),
    readerRole: z.string().max(200).optional(),
    keyword: z.string().max(200).nullable().optional(),
    tags: z.array(z.string().min(1).max(100)).max(30).optional(),
    status: Status.optional(),
    ownerId: z.string().max(200).nullable().optional(),
    ownerName: z.string().max(200).nullable().optional(),
    targetDate: TargetDate.nullable().optional(),
    canonicalUrl: z.string().url().max(2000).nullable().optional(),
    campaignId: CampaignRef.nullable().optional(),
    broadcastId: BroadcastRef.nullable().optional(),
    similarTopicIds: z.array(z.string()).max(50).optional(),
  }),
  output: z.object({ topic: Topic }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.topicId,
  handler: async (input, ctx) => {
    const topic = await loadTopic(ctx, input.topicId);
    if (ctx.principal.type === 'agent') {
      if (input.ownerId !== undefined || input.ownerName !== undefined) assertAgentMayWrite(ctx, 'assign a topic owner');
      if (input.canonicalUrl !== undefined) assertAgentMayWrite(ctx, 'set the published URL');
      checkStatusForAgent(ctx, input.status);
      if (input.status === 'published' || input.status === 'approved' || input.status === 'archived')
        assertAgentMayWrite(ctx, `set a topic to ${input.status}`);
    }
    const status = input.status ?? topic.status;
    const canonicalUrl = input.canonicalUrl !== undefined ? input.canonicalUrl : topic.canonicalUrl;
    if (status === 'published' && !canonicalUrl) throw new AppError('invalid_input', 'A topic can only be published with a canonical URL.');
    if (status === 'archived' && topic.status === 'archived') throw new AppError('conflict', `Topic ${topic.id} is already archived.`);

    const set: Partial<typeof schema.contentTopics.$inferInsert> = { status, updatedAt: new Date() };
    if (input.title !== undefined) set.title = input.title;
    if (input.angle !== undefined) set.angle = input.angle;
    if (input.audience !== undefined) set.audience = input.audience;
    if (input.readerRole !== undefined) set.readerRole = input.readerRole;
    if (input.keyword !== undefined) set.keyword = input.keyword;
    if (input.tags !== undefined) set.tags = input.tags;
    if (input.ownerId !== undefined) set.ownerId = input.ownerId;
    if (input.ownerName !== undefined) set.ownerName = input.ownerName;
    if (input.targetDate !== undefined) set.targetDate = input.targetDate;
    if (input.canonicalUrl !== undefined) set.canonicalUrl = input.canonicalUrl;
    if (input.campaignId !== undefined) set.campaignId = input.campaignId;
    if (input.broadcastId !== undefined) set.broadcastId = input.broadcastId;
    if (input.similarTopicIds !== undefined) set.similarTopicIds = input.similarTopicIds;
    if (input.title !== undefined || input.keyword !== undefined)
      set.dedupeKey = topicDedupeKey(input.title ?? topic.title, input.keyword !== undefined ? input.keyword : topic.keyword);

    const [row] = await ctx.tx
      .update(schema.contentTopics)
      .set(set)
      .where(and(eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId), eq(schema.contentTopics.id, topic.id)))
      .returning();
    return { topic: toTopic(row) };
  },
});

export const scoreContentTopic = defineCommand({
  name: 'content.topics.score',
  title: 'Score a topic',
  description:
    'Set a topic’s score and the signals behind it. Without an explicit score, the score is the sum of the signal weights (clamped to 0–100). People and agents may score; a scored topic moves from idea to scored, and a later status is left alone.',
  input: z.object({
    topicId: TopicId,
    score: z.number().int().min(0).max(100).optional().describe('Explicit score; defaults to the sum of the signal weights'),
    signals: z.array(Signal).max(100).optional().describe('Replace the topic’s signals; omit to keep the current ones'),
  }),
  output: z.object({ topic: Topic }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.topicId,
  handler: async (input, ctx) => {
    if (input.score === undefined && input.signals === undefined)
      throw new AppError('invalid_input', 'Pass a score, signals, or both: scoring a topic needs something behind the number.');
    const topic = await loadTopic(ctx, input.topicId);
    if (topic.status === 'archived') throw new AppError('conflict', `Topic ${topic.id} is archived; restore it before scoring.`);
    const signals = input.signals ?? topic.signals;
    const score = input.score ?? scoreFromSignals(signals);
    const status: ContentTopicStatus = topic.status === 'idea' ? 'scored' : topic.status;
    const [row] = await ctx.tx
      .update(schema.contentTopics)
      .set({ score, signals, status, updatedAt: new Date() })
      .where(and(eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId), eq(schema.contentTopics.id, topic.id)))
      .returning();
    return { topic: toTopic(row) };
  },
});

export const archiveContentTopic = defineCommand({
  name: 'content.topics.archive',
  title: 'Archive a topic',
  description:
    'Take a topic out of the backlog without deleting it or its brief: the row, the brief artifact and a published URL stay. Archived topics are left out of the list unless asked for and a brief publish no longer moves them.',
  input: z.object({ topicId: TopicId }),
  output: z.object({ topic: Topic, archived: z.literal(true) }),
  permission: 'artifacts:write',
  effect: 'write',
  humansOnly: true,
  actionClass: 'destructive',
  target: (input) => input.topicId,
  handler: async (input, ctx) => {
    const topic = await loadTopic(ctx, input.topicId);
    if (topic.status === 'archived') throw new AppError('conflict', `Topic ${topic.id} is already archived.`);
    const [row] = await ctx.tx
      .update(schema.contentTopics)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId), eq(schema.contentTopics.id, topic.id)))
      .returning();
    return { topic: toTopic(row), archived: true as const };
  },
});

export const topicToBrief = defineCommand({
  name: 'content.topics.toBrief',
  title: 'Create a brief from a topic',
  description:
    'Create a content_brief artifact draft from a topic, seeded with its title, audience, angle, keyword and content-item sources. The topic moves to brief and stores the artifact id; the brief then follows the normal artifact flow (edit, requestPublish, a person approves). Agents may draft it.',
  input: z.object({
    topicId: TopicId,
    name: z.string().min(1).max(120).optional().describe('Artifact name; defaults to the topic title'),
    note: z.string().max(500).optional(),
  }),
  output: z.object({
    topicId: z.string(),
    artifactId: z.string(),
    version: z.number().int(),
    status: z.literal('brief'),
    brief: z.object({ title: z.string(), artifactId: z.string() }),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (input) => input.topicId,
  handler: async (input, ctx) => {
    const topic = await loadTopic(ctx, input.topicId);
    if (topic.status === 'archived') throw new AppError('conflict', `Topic ${topic.id} is archived; restore it before drafting a brief.`);
    if (topic.status === 'published') throw new AppError('conflict', `Topic ${topic.id} is already published; it no longer needs a brief.`);
    if (topic.briefArtifactId)
      throw new AppError('conflict', `Topic ${topic.id} already has brief ${topic.briefArtifactId}. Edit that brief instead.`);

    const content = {
      topicId: topic.id,
      title: input.name ?? topic.title,
      thesis: '',
      audience: topic.audience,
      readerRole: topic.readerRole,
      angle: topic.angle,
      whyNow: '',
      outline: [],
      keyPoints: [],
      sources: topic.signals.flatMap((signal) =>
        signal.kind === 'content_item' && signal.id
          ? [{ kind: 'content_item' as const, id: signal.id, title: signal.title, url: signal.url, note: undefined }]
          : [],
      ),
      doNots: [],
      risks: [],
      mondayTest: '',
      successMeasure: '',
      voice: '',
      cta: '',
      internalLinks: [],
      keyword: topic.keyword ?? '',
      intent: '',
    };
    const created = await createArtifact.handler(
      {
        type: 'content_brief',
        name: input.name ?? topic.title,
        content,
        note: input.note ?? `From topic “${topic.title}”`,
      },
      ctx,
    );
    await ctx.tx
      .update(schema.contentTopics)
      .set({ status: 'brief', briefArtifactId: created.artifactId, updatedAt: new Date() })
      .where(and(eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId), eq(schema.contentTopics.id, topic.id)));
    return {
      topicId: topic.id,
      artifactId: created.artifactId,
      version: created.version,
      status: 'brief' as const,
      brief: { title: input.name ?? topic.title, artifactId: created.artifactId },
    };
  },
});

/**
 * Publishing a brief approves its topic: the brief is the contract, so once a person approves it
 * (or the policy publishes it directly) the backlog reflects that. A topic that is already
 * drafting or published is not moved back to approved; an archived topic stays archived.
 */
publishHooks.push(async (ctx, artifact, version) => {
  if (artifact.type !== 'content_brief') return;
  const [row] = await ctx.tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
        eq(schema.artifactVersions.artifactId, artifact.id),
        eq(schema.artifactVersions.number, version),
      ),
    );
  if (!row) return;
  const parsed = artifactTypes.content_brief.content.safeParse(row.content);
  if (!parsed.success) return;
  const topicId = parsed.data.topicId;
  await ctx.tx
    .update(schema.contentTopics)
    .set({ briefArtifactId: artifact.id, updatedAt: new Date() })
    .where(
      and(
        eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId),
        eq(schema.contentTopics.id, topicId),
        ne(schema.contentTopics.status, 'archived'),
      ),
    );
  await ctx.tx
    .update(schema.contentTopics)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(
      and(
        eq(schema.contentTopics.workspaceId, ctx.principal.workspaceId),
        eq(schema.contentTopics.id, topicId),
        inArray(schema.contentTopics.status, ['idea', 'scored', 'brief']),
      ),
    );
});

/** A brief cannot go live without the argument, the reader and a Monday test, and a source or a reason. */
publishValidators.set('content_brief', async (content, tx, artifact) => {
  const parsed = artifactTypes.content_brief.content.safeParse(content);
  if (!parsed.success) return [];
  const brief = parsed.data;
  const problems: string[] = [];
  if (!brief.thesis.trim()) problems.push('a brief needs a thesis: the argument the piece makes, not a summary');
  if (!brief.audience.trim()) problems.push('a brief needs an audience');
  if (!brief.mondayTest.trim()) problems.push('a brief needs a Monday test: what a marketing ops person does differently after reading it');
  if (!brief.sources.length && !brief.noSourcesReason?.trim())
    problems.push('a brief needs at least one source, or an explicit noSourcesReason');
  const [topic] = await tx
    .select({ id: schema.contentTopics.id, briefArtifactId: schema.contentTopics.briefArtifactId })
    .from(schema.contentTopics)
    .where(eq(schema.contentTopics.id, brief.topicId));
  if (!topic) problems.push(`topic ${brief.topicId} does not exist in this workspace`);
  else if (topic.briefArtifactId && topic.briefArtifactId !== artifact?.id)
    problems.push(`topic ${topic.id} belongs to brief ${topic.briefArtifactId}`);
  return problems;
});

referenceExtractors.set('content_brief', (content) => {
  const parsed = artifactTypes.content_brief.content.safeParse(content);
  if (!parsed.success) return [];
  return [parsed.data.topicId, ...parsed.data.sources.flatMap((source) => (source.id ? [source.id] : source.url ? [source.url] : []))];
});

export const contentTopicCommands = [
  listContentTopics,
  createContentTopic,
  updateContentTopic,
  scoreContentTopic,
  archiveContentTopic,
  topicToBrief,
] as const;
