import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CommandError, defineCommand, type CommandContext } from '../registry';
import { artifacts, artifactVersions, auditLog, workspaces } from '../db/schema';

const nodeKinds = ['trigger', 'wait', 'waitEvent', 'branch', 'split', 'email', 'webhook', 'updateProfile', 'aiDecide', 'aiGenerate', 'goal', 'exit'] as const;

const JourneyNode = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).describe('Short id unique in this journey, e.g. "n1"'),
  kind: z.enum(nodeKinds),
  label: z.string().min(1).max(120),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}).describe('Step settings, e.g. {"duration":"P2D"}'),
  next: z
    .array(z.object({ to: z.string(), label: z.string().max(40).optional() }))
    .optional()
    .describe('Steps this one continues to. Omit to continue to the following node.'),
});

const JourneyGraph = z
  .array(JourneyNode)
  .min(1)
  .max(200)
  .superRefine((nodes, ctx) => {
    const ids = new Set<string>();
    for (const n of nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `Duplicate node id "${n.id}"` });
      ids.add(n.id);
    }
    for (const n of nodes)
      for (const e of n.next ?? []) if (!ids.has(e.to)) ctx.addIssue({ code: 'custom', message: `Node "${n.id}" continues to unknown node "${e.to}"` });
    const triggers = nodes.filter((n) => n.kind === 'trigger').length;
    if (triggers !== 1) ctx.addIssue({ code: 'custom', message: `A journey needs exactly one trigger node, found ${triggers}` });
  });

const VersionState = z.enum(['draft', 'in_review', 'published', 'superseded']);
const Author = z.object({ type: z.enum(['user', 'agent']), id: z.string(), client: z.string().nullable() });
const JourneyId = z.string().regex(/^jrn_[a-z0-9_]{1,40}$/).describe('Journey id, e.g. "jrn_welcome"');

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const author = (ctx: CommandContext) => ({
  authorType: ctx.principal.type,
  authorId: ctx.principal.userId,
  authorClient: ctx.principal.clientId ?? null,
});

async function latestVersion(ctx: CommandContext, journeyId: string) {
  const [v] = await ctx.tx
    .select()
    .from(artifactVersions)
    .where(and(eq(artifactVersions.workspaceId, ctx.principal.workspaceId), eq(artifactVersions.artifactId, journeyId)))
    .orderBy(desc(artifactVersions.number))
    .limit(1);
  if (!v) throw new CommandError('not_found', `Journey ${journeyId} not found`);
  return v;
}

async function publish(ctx: CommandContext, journeyId: string, number: number) {
  const ws = ctx.principal.workspaceId;
  await ctx.tx
    .update(artifactVersions)
    .set({ state: 'superseded' })
    .where(and(eq(artifactVersions.workspaceId, ws), eq(artifactVersions.artifactId, journeyId), eq(artifactVersions.state, 'published')));
  await ctx.tx
    .update(artifactVersions)
    .set({ state: 'published' })
    .where(and(eq(artifactVersions.workspaceId, ws), eq(artifactVersions.artifactId, journeyId), eq(artifactVersions.number, number)));
  await ctx.tx.update(artifacts).set({ publishedVersion: number }).where(and(eq(artifacts.workspaceId, ws), eq(artifacts.id, journeyId)));
}

export const createDraft = defineCommand({
  name: 'journeys.createDraft',
  title: 'Create journey draft',
  description:
    'Create a new journey as an unpublished draft (version 1). Nodes run in list order unless a node names its successors in `next`. Publishing is a separate step (journeys.requestPublish).',
  input: z.object({
    id: JourneyId,
    name: z.string().min(1).max(120),
    purpose: z.enum(['onboarding', 'marketing_email']).describe('Purpose of the messages; the send gateway looks up the lawful basis from it'),
    goal: z.string().max(200).optional(),
    nodes: JourneyGraph,
  }),
  output: z.object({ journeyId: z.string(), version: z.number().int(), state: VersionState }),
  permission: 'journeys:write',
  effect: 'write',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [exists] = await ctx.tx.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.workspaceId, ws), eq(artifacts.id, input.id)));
    if (exists) throw new CommandError('conflict', `Journey ${input.id} already exists; use journeys.updateDraft`);
    const content = { purpose: input.purpose, goal: input.goal ?? null, nodes: input.nodes };
    await ctx.tx.insert(artifacts).values({ workspaceId: ws, id: input.id, type: 'journey', name: input.name });
    await ctx.tx.insert(artifactVersions).values({ workspaceId: ws, artifactId: input.id, number: 1, state: 'draft', content, contentHash: hash(content), note: 'Initial draft', ...author(ctx) });
    return { journeyId: input.id, version: 1, state: 'draft' as const };
  },
});

export const updateDraft = defineCommand({
  name: 'journeys.updateDraft',
  title: 'Update journey draft',
  description: 'Replace the graph of a journey. Edits the current draft, or creates a new draft version if the latest version is published or in review.',
  input: z.object({ journeyId: JourneyId, nodes: JourneyGraph, note: z.string().max(500).optional() }),
  output: z.object({ journeyId: z.string(), version: z.number().int(), state: VersionState }),
  permission: 'journeys:write',
  effect: 'write',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const latest = await latestVersion(ctx, input.journeyId);
    const content = { ...(latest.content as object), nodes: input.nodes };
    if (latest.state === 'draft') {
      await ctx.tx
        .update(artifactVersions)
        .set({ content, contentHash: hash(content), note: input.note ?? latest.note, ...author(ctx) })
        .where(and(eq(artifactVersions.workspaceId, ws), eq(artifactVersions.artifactId, input.journeyId), eq(artifactVersions.number, latest.number)));
      return { journeyId: input.journeyId, version: latest.number, state: 'draft' as const };
    }
    const number = latest.number + 1;
    await ctx.tx.insert(artifactVersions).values({ workspaceId: ws, artifactId: input.journeyId, number, state: 'draft', content, contentHash: hash(content), note: input.note ?? null, ...author(ctx) });
    return { journeyId: input.journeyId, version: number, state: 'draft' as const };
  },
});

export const getJourney = defineCommand({
  name: 'journeys.get',
  title: 'Get journey',
  description: 'Read a journey and one of its versions (default: the latest).',
  input: z.object({ journeyId: JourneyId, version: z.number().int().positive().optional() }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    publishedVersion: z.number().int().nullable(),
    version: z.object({ number: z.number().int(), state: VersionState, author: Author, note: z.string().nullable(), content: z.unknown() }),
  }),
  permission: 'journeys:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [j] = await ctx.tx.select().from(artifacts).where(and(eq(artifacts.workspaceId, ws), eq(artifacts.id, input.journeyId)));
    if (!j) throw new CommandError('not_found', `Journey ${input.journeyId} not found`);
    const v = input.version
      ? (
          await ctx.tx
            .select()
            .from(artifactVersions)
            .where(and(eq(artifactVersions.workspaceId, ws), eq(artifactVersions.artifactId, j.id), eq(artifactVersions.number, input.version)))
        )[0]
      : await latestVersion(ctx, j.id);
    if (!v) throw new CommandError('not_found', `Version ${input.version} not found`);
    return {
      id: j.id,
      name: j.name,
      publishedVersion: j.publishedVersion,
      version: { number: v.number, state: v.state as z.infer<typeof VersionState>, author: { type: v.authorType as 'user' | 'agent', id: v.authorId, client: v.authorClient }, note: v.note, content: v.content },
    };
  },
});

export const listJourneys = defineCommand({
  name: 'journeys.list',
  title: 'List journeys',
  description: 'List the journeys in this workspace with their published version.',
  input: z.object({}),
  output: z.object({ journeys: z.array(z.object({ id: z.string(), name: z.string(), publishedVersion: z.number().int().nullable() })) }),
  permission: 'journeys:read',
  effect: 'read',
  // No WHERE on workspace here on purpose: row-level security does the scoping.
  handler: async (_input, ctx) => ({
    journeys: await ctx.tx.select({ id: artifacts.id, name: artifacts.name, publishedVersion: artifacts.publishedVersion }).from(artifacts).where(eq(artifacts.type, 'journey')),
  }),
});

export const requestPublish = defineCommand({
  name: 'journeys.requestPublish',
  title: 'Publish journey (or request approval)',
  description:
    'Publish the latest draft. Depending on the workspace approval policy this publishes immediately or puts the version in review for a person to approve.',
  input: z.object({ journeyId: JourneyId, note: z.string().max(500) }),
  output: z.object({ status: z.enum(['published', 'in_review']), version: z.number().int(), policy: z.string() }),
  permission: 'journeys:publish',
  effect: 'publish',
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const latest = await latestVersion(ctx, input.journeyId);
    if (latest.state !== 'draft') throw new CommandError('conflict', `Latest version v${latest.number} is ${latest.state}, not a draft`);
    const [w] = await ctx.tx.select({ policy: workspaces.approvalPolicy }).from(workspaces).where(eq(workspaces.id, ws));
    const needsApproval = w.policy === 'all_publishes' || (w.policy === 'agent_changes' && (ctx.principal.type === 'agent' || latest.authorType === 'agent'));
    if (!needsApproval) {
      await publish(ctx, input.journeyId, latest.number);
      return { status: 'published' as const, version: latest.number, policy: w.policy };
    }
    await ctx.tx
      .update(artifactVersions)
      .set({ state: 'in_review', note: input.note })
      .where(and(eq(artifactVersions.workspaceId, ws), eq(artifactVersions.artifactId, input.journeyId), eq(artifactVersions.number, latest.number)));
    return { status: 'in_review' as const, version: latest.number, policy: w.policy };
  },
});

export const approve = defineCommand({
  name: 'journeys.approve',
  title: 'Approve and publish journey version',
  description: 'Approve a version that is in review and publish it. Only people can approve.',
  input: z.object({ journeyId: JourneyId, version: z.number().int().positive() }),
  output: z.object({ status: z.literal('published'), version: z.number().int() }),
  permission: 'journeys:publish',
  effect: 'publish',
  humansOnly: true,
  handler: async (input, ctx) => {
    const [v] = await ctx.tx
      .select()
      .from(artifactVersions)
      .where(and(eq(artifactVersions.workspaceId, ctx.principal.workspaceId), eq(artifactVersions.artifactId, input.journeyId), eq(artifactVersions.number, input.version)));
    if (!v) throw new CommandError('not_found', 'Version not found');
    if (v.state !== 'in_review') throw new CommandError('conflict', `Version is ${v.state}, not in review`);
    await publish(ctx, input.journeyId, input.version);
    return { status: 'published' as const, version: input.version };
  },
});

export const listAudit = defineCommand({
  name: 'audit.list',
  title: 'Read audit log',
  description: 'Most recent audit entries: who ran which command, through which surface, and whether it succeeded.',
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({
    entries: z.array(
      z.object({
        seq: z.number(),
        at: z.string(),
        principalType: z.string(),
        principalId: z.string(),
        clientId: z.string().nullable(),
        surface: z.string(),
        command: z.string(),
        ok: z.boolean(),
        error: z.string().nullable(),
        hash: z.string(),
        prevHash: z.string().nullable(),
      }),
    ),
  }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(input.limit);
    return { entries: rows.map((r) => ({ ...r, at: r.at.toISOString() })) };
  },
});
