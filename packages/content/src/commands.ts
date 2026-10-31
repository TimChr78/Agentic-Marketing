import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { checkUrl, type EgressPolicy } from '@agentic-marketing/integrations';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { fetchSource } from './fetch';
import { CONTENT_POLICY_VERSION, CONTENT_SECTIONS } from './score';
import { canonicalUrl } from './urls';

// Content source commands (#140): sources, the normalised library and versioned selections.
// Sources are configuration, so creating or changing one is people-only like a connector; agents
// read everything and may create a draft selection. Fetching is a bounded read of a public feed.

declare module '@agentic-marketing/commands' {
  interface Services {
    egress?: EgressPolicy;
  }
}

const SourceId = z.string().regex(/^csrc_[0-9a-f]{32}$/);
const ItemId = z.string().regex(/^citem_[0-9a-f]{32}$/);
const SelectionId = z.string().regex(/^csel_[0-9a-f]{32}$/);
const Categories = ['platform', 'publication', 'vendor', 'community', 'open source', 'thought leader', 'other'] as const;
const Sections = CONTENT_SECTIONS;

const Source = z.object({
  id: z.string(),
  kind: z.enum(['rss', 'atom', 'json']),
  url: z.string(),
  name: z.string(),
  category: z.enum(Categories),
  authority: z.number().int(),
  language: z.string(),
  enabled: z.boolean(),
  fetchIntervalMinutes: z.number().int(),
  lastFetchAt: z.string().nullable(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.string(),
});
type SourceRow = typeof schema.contentSources.$inferSelect;
const sourceOut = (r: SourceRow) => ({
  id: r.id,
  kind: r.kind,
  url: r.url,
  name: r.name,
  category: r.category,
  authority: r.authority,
  language: r.language,
  enabled: r.enabled,
  fetchIntervalMinutes: r.fetchIntervalMinutes,
  lastFetchAt: r.lastFetchAt?.toISOString() ?? null,
  etag: r.etag,
  lastModified: r.lastModified,
  lastError: r.lastError,
  consecutiveFailures: r.consecutiveFailures,
  createdAt: r.createdAt.toISOString(),
});

const ScoreExplanation = z.object({
  policyVersion: z.string(),
  total: z.number(),
  matchedKeywords: z.array(z.string()),
  section: z.string(),
  components: z.array(z.object({ kind: z.string(), label: z.string(), points: z.number(), detail: z.string() })),
  summary: z.string(),
});

const Item = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  canonicalUrl: z.string(),
  title: z.string(),
  excerpt: z.string(),
  author: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  section: z.string(),
  status: z.enum(['new', 'selected', 'ignored', 'used']),
  relevanceScore: z.number().int(),
  scoreExplanation: ScoreExplanation,
});
type ItemRow = typeof schema.contentItems.$inferSelect;
const itemOut = (r: ItemRow, sourceName: string) => ({
  id: r.id,
  sourceId: r.sourceId,
  sourceName,
  canonicalUrl: r.canonicalUrl,
  title: r.title,
  excerpt: r.excerpt,
  author: r.author,
  publishedAt: r.publishedAt?.toISOString() ?? null,
  fetchedAt: r.fetchedAt.toISOString(),
  section: r.section,
  status: r.status,
  relevanceScore: r.relevanceScore,
  scoreExplanation: r.scoreExplanation,
});

const SelectionItem = z.object({
  itemId: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  title: z.string(),
  url: z.string(),
  excerpt: z.string(),
  author: z.string().nullable(),
  publishedAt: z.string().nullable(),
  score: z.number(),
  section: z.string(),
});
const SelectionSection = z.object({
  name: z.string(),
  note: z.string().nullable(),
  items: z.array(SelectionItem),
});
const Selection = z.object({
  id: z.string(),
  name: z.string(),
  issueDate: z.string(),
  version: z.number().int(),
  status: z.enum(['draft', 'approved']),
  sections: z.array(SelectionSection),
  policyVersion: z.string(),
  createdByType: z.enum(['user', 'agent']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type SelectionRow = typeof schema.contentSelections.$inferSelect;
const selectionOut = (r: SelectionRow) => ({
  id: r.id,
  name: r.name,
  issueDate: r.issueDate,
  version: r.version,
  status: r.status,
  sections: r.sections,
  policyVersion: r.policyVersion,
  createdByType: r.createdByType,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

function authorTypeOf(ctx: CommandContext): 'user' | 'agent' {
  return ctx.principal.type;
}
function authorIdOf(ctx: CommandContext): string {
  return ctx.principal.agent?.id ?? ctx.principal.userId;
}

function checkedUrl(raw: string, egress: EgressPolicy): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError('invalid_input', `${raw} is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new AppError('invalid_input', 'Only http and https feed URLs are allowed.');
  const problem = checkUrl(raw, egress);
  if (problem) throw new AppError('invalid_input', `The feed URL is not allowed: ${problem}.`);
  return canonicalUrl(raw);
}

export const listContentSources = defineCommand({
  name: 'content.sources.list',
  title: 'List content sources',
  description:
    'Content sources (RSS, Atom or JSON Feed) with their interval, last fetch, last error and consecutive failures. A failing source stays here until it is fixed or paused.',
  input: z.object({}),
  output: z.object({ sources: z.array(Source) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => ({
    sources: (await ctx.tx.select().from(schema.contentSources).orderBy(desc(schema.contentSources.createdAt))).map(sourceOut),
  }),
});

export const createContentSource = defineCommand({
  name: 'content.sources.create',
  title: 'Add a content source',
  description:
    'Add an RSS, Atom or JSON Feed the workspace may fetch. The URL must be public (the egress guard refuses private addresses unless EGRESS_ALLOWED_HOSTS allows them). Only an excerpt and the canonical link are stored, never the full article.',
  input: z.object({
    kind: z.enum(['rss', 'atom', 'json']),
    url: z.string().min(1).max(2000),
    name: z.string().min(1).max(160),
    category: z.enum(Categories).default('other'),
    authority: z.number().int().min(1).max(5).default(3).describe('Source authority 1–5; it is part of every item score'),
    language: z.string().min(2).max(10).default('en'),
    enabled: z.boolean().default(true),
    fetchIntervalMinutes: z.number().int().min(5).max(10_080).default(360),
  }),
  output: Source,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    const url = checkedUrl(input.url, ctx.services.egress ?? { allowedHosts: [] });
    const [existing] = await ctx.tx
      .select({ id: schema.contentSources.id })
      .from(schema.contentSources)
      .where(eq(schema.contentSources.url, url));
    if (existing) throw new AppError('conflict', `A source for ${url} already exists (${existing.id}).`);
    const [row] = await ctx.tx
      .insert(schema.contentSources)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('csrc'),
        kind: input.kind,
        url,
        name: input.name,
        category: input.category,
        authority: input.authority,
        language: input.language,
        enabled: input.enabled,
        fetchIntervalMinutes: input.fetchIntervalMinutes,
        createdByType: authorTypeOf(ctx),
        createdById: authorIdOf(ctx),
      })
      .returning();
    return sourceOut(row);
  },
});

export const updateContentSource = defineCommand({
  name: 'content.sources.update',
  title: 'Change a content source',
  description:
    'Rename, pause, change the interval, authority, category or URL of a content source. Changing the URL clears the stored ETag.',
  input: z.object({
    id: SourceId,
    name: z.string().min(1).max(160).optional(),
    url: z.string().min(1).max(2000).optional(),
    category: z.enum(Categories).optional(),
    authority: z.number().int().min(1).max(5).optional(),
    language: z.string().min(2).max(10).optional(),
    enabled: z.boolean().optional(),
    fetchIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
  }),
  output: Source,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.id,
  handler: async ({ id, url: rawUrl, ...rest }, ctx) => {
    const [current] = await ctx.tx.select().from(schema.contentSources).where(eq(schema.contentSources.id, id));
    if (!current) throw new AppError('not_found', `No content source ${id}.`);
    let url: string | undefined;
    if (rawUrl) {
      url = checkedUrl(rawUrl, ctx.services.egress ?? { allowedHosts: [] });
      const [other] = await ctx.tx
        .select({ id: schema.contentSources.id })
        .from(schema.contentSources)
        .where(eq(schema.contentSources.url, url));
      if (other && other.id !== id) throw new AppError('conflict', `A source for ${url} already exists (${other.id}).`);
    }
    const [row] = await ctx.tx
      .update(schema.contentSources)
      .set({
        ...rest,
        ...(url ? { url, etag: null, lastModified: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.contentSources.id, id))
      .returning();
    return sourceOut(row);
  },
});

export const fetchContentSource = defineCommand({
  name: 'content.sources.fetch',
  title: 'Fetch a content source now',
  description:
    'Fetch one source outside its interval, through the egress guard and the size/time bounds. A 304 keeps the items as they are; a failure is recorded on the source and reported here.',
  input: z.object({ id: SourceId }),
  output: z.object({
    sourceId: z.string(),
    status: z.enum(['ok', 'not_modified', 'failed']),
    itemsAdded: z.number().int(),
    itemsUpdated: z.number().int(),
    error: z.string().nullable(),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'data.write',
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const [source] = await ctx.tx.select().from(schema.contentSources).where(eq(schema.contentSources.id, input.id));
    if (!source) throw new AppError('not_found', `No content source ${input.id}.`);
    return fetchSource(ctx.tx, source, { egress: ctx.services.egress ?? { allowedHosts: [] } }, new Date());
  },
});

export const listContentItems = defineCommand({
  name: 'content.items.list',
  title: 'List content items',
  description:
    'Normalised articles from the sources, with the relevance score and the components behind it. Filter by source, section, status, minimum score or a fetched-at range; the excerpt is all that is stored.',
  input: z.object({
    sourceId: SourceId.optional(),
    section: z.enum(Sections).optional(),
    status: z.enum(['new', 'selected', 'ignored', 'used']).optional(),
    minScore: z.number().int().min(0).optional(),
    since: z.string().datetime().optional().describe('Only items fetched at or after this ISO time'),
    until: z.string().datetime().optional().describe('Only items fetched at or before this ISO time'),
    orderBy: z.enum(['score', 'recent']).default('score'),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({ items: z.array(Item), hasMore: z.boolean() }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const where = [
      input.sourceId ? eq(schema.contentItems.sourceId, input.sourceId) : undefined,
      input.section ? eq(schema.contentItems.section, input.section) : undefined,
      input.status ? eq(schema.contentItems.status, input.status) : undefined,
      input.minScore !== undefined ? gte(schema.contentItems.relevanceScore, input.minScore) : undefined,
      input.since ? gte(schema.contentItems.fetchedAt, new Date(input.since)) : undefined,
      input.until ? lte(schema.contentItems.fetchedAt, new Date(input.until)) : undefined,
    ].filter((clause) => clause !== undefined);
    const rows = await ctx.tx
      .select({ item: schema.contentItems, sourceName: schema.contentSources.name })
      .from(schema.contentItems)
      .innerJoin(schema.contentSources, eq(schema.contentItems.sourceId, schema.contentSources.id))
      .where(where.length ? and(...where) : undefined)
      .orderBy(
        input.orderBy === 'recent' ? desc(schema.contentItems.fetchedAt) : desc(schema.contentItems.relevanceScore),
        desc(schema.contentItems.fetchedAt),
      )
      .limit(input.limit + 1)
      .offset(input.offset);
    const items = rows.slice(0, input.limit).map((r) => itemOut(r.item, r.sourceName));
    return { items, hasMore: rows.length > input.limit };
  },
});

export const createContentSelection = defineCommand({
  name: 'content.selections.create',
  title: 'Create a content selection',
  description:
    'Save a named, dated version of chosen items per section. Each item is snapshotted (title, source, URL, excerpt) so pruning the library does not change it. Agents create drafts; a person approves one before it is used for an issue.',
  input: z.object({
    name: z.string().min(1).max(160),
    issueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('The issue or brief date, YYYY-MM-DD; defaults to today'),
    sections: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          note: z.string().max(500).nullable().optional(),
          itemIds: z.array(ItemId).max(50).default([]),
        }),
      )
      .min(1)
      .max(12),
  }),
  output: Selection,
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    const ids = [...new Set(input.sections.flatMap((s) => s.itemIds))];
    const rows = ids.length
      ? await ctx.tx
          .select({ item: schema.contentItems, sourceName: schema.contentSources.name })
          .from(schema.contentItems)
          .innerJoin(schema.contentSources, eq(schema.contentItems.sourceId, schema.contentSources.id))
          .where(inArray(schema.contentItems.id, ids))
      : [];
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.item.id));
      const missing = ids.filter((id) => !found.has(id));
      throw new AppError('invalid_input', `These items do not exist in this workspace: ${missing.join(', ')}.`);
    }
    const byId = new Map(rows.map((r) => [r.item.id, r]));
    const sections = input.sections.map((section) => ({
      name: section.name,
      note: section.note ?? null,
      items: section.itemIds.map((id) => {
        const { item, sourceName } = byId.get(id)!;
        return {
          itemId: item.id,
          sourceId: item.sourceId,
          sourceName,
          title: item.title,
          url: item.canonicalUrl,
          excerpt: item.excerpt,
          author: item.author,
          publishedAt: item.publishedAt?.toISOString() ?? null,
          score: item.relevanceScore,
          section: item.section,
        };
      }),
    }));
    const [latest] = await ctx.tx
      .select({ version: sql<number>`coalesce(max(${schema.contentSelections.version}), 0)` })
      .from(schema.contentSelections)
      .where(and(eq(schema.contentSelections.workspaceId, ctx.principal.workspaceId), eq(schema.contentSelections.name, input.name)));
    const [row] = await ctx.tx
      .insert(schema.contentSelections)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('csel'),
        name: input.name,
        issueDate: input.issueDate ?? new Date().toISOString().slice(0, 10),
        version: Number(latest?.version ?? 0) + 1,
        status: 'draft',
        sections,
        policyVersion: rows[0]?.item.policyVersion ?? CONTENT_POLICY_VERSION,
        createdByType: authorTypeOf(ctx),
        createdById: authorIdOf(ctx),
      })
      .returning();
    return selectionOut(row);
  },
});

export const getContentSelection = defineCommand({
  name: 'content.selections.get',
  title: 'Get a content selection',
  description: 'One versioned selection with its snapshot of items, sections and notes.',
  input: z.object({ id: SelectionId }),
  output: Selection,
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.contentSelections).where(eq(schema.contentSelections.id, input.id));
    if (!row) throw new AppError('not_found', `No content selection ${input.id}.`);
    return selectionOut(row);
  },
});

export const listContentSelections = defineCommand({
  name: 'content.selections.list',
  title: 'List content selections',
  description: 'Selections newest first, with every version kept. Filter by name to see a selection’s history.',
  input: z.object({
    name: z.string().min(1).max(160).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({ selections: z.array(Selection), hasMore: z.boolean() }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.contentSelections)
      .where(input.name ? eq(schema.contentSelections.name, input.name) : undefined)
      .orderBy(desc(schema.contentSelections.issueDate), desc(schema.contentSelections.createdAt))
      .limit(input.limit + 1)
      .offset(input.offset);
    return { selections: rows.slice(0, input.limit).map(selectionOut), hasMore: rows.length > input.limit };
  },
});

export const contentCommands = [
  listContentSources,
  createContentSource,
  updateContentSource,
  fetchContentSource,
  listContentItems,
  createContentSelection,
  getContentSelection,
  listContentSelections,
] as const;
