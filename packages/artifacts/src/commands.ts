import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, hashValue, newId } from '@agentic-marketing/core';
import { schema, type VersionState } from '@agentic-marketing/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { diffJson } from './diff';
import { type ArtifactType, artifactTypeEnum, artifactTypes } from './types';

// Generic, versioned artifacts with a configurable approval pipeline (journeys-and-editors.md §5).
// Published versions are immutable; edits always produce or update a draft.

const ArtifactId = z
  .string()
  .regex(/^[a-z]{2,5}_[0-9a-f]{32}$/)
  .describe('Artifact id, e.g. "jrn_0192…"');
const VersionStateSchema = z.enum(['draft', 'in_review', 'published', 'superseded', 'rejected']);
const Author = z.object({ type: z.enum(['user', 'agent']), id: z.string(), client: z.string().nullable() });
const VersionSummary = z.object({
  number: z.number().int(),
  state: VersionStateSchema,
  author: Author,
  note: z.string().nullable(),
  contentHash: z.string(),
  basedOn: z.number().int().nullable(),
  createdAt: z.string(),
});

type VersionRow = typeof schema.artifactVersions.$inferSelect;
const toSummary = (v: VersionRow) => ({
  number: v.number,
  state: v.state,
  author: { type: v.authorType, id: v.authorId, client: v.authorClient },
  note: v.note,
  contentHash: v.contentHash,
  basedOn: v.basedOn,
  createdAt: v.createdAt.toISOString(),
});
const author = (ctx: CommandContext) => ({
  authorType: ctx.principal.type,
  authorId: ctx.principal.userId,
  authorClient: ctx.principal.clientId ?? null,
});

function validateContent(type: ArtifactType, content: unknown) {
  const parsed = (artifactTypes[type].content as z.ZodType).safeParse(content);
  if (!parsed.success)
    throw new AppError(
      'invalid_input',
      `The content is not a valid ${type}. Call artifacts.types for the schema.`,
      z.treeifyError(parsed.error),
    );
  return parsed.data as Record<string, unknown>;
}

async function loadArtifact(ctx: CommandContext, artifactId: string) {
  const [a] = await ctx.tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, artifactId)));
  if (!a) throw new AppError('not_found', `Artifact ${artifactId} does not exist in this workspace.`);
  return a;
}

async function loadVersion(ctx: CommandContext, artifactId: string, number: number) {
  const [v] = await ctx.tx
    .select()
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
        eq(schema.artifactVersions.artifactId, artifactId),
        eq(schema.artifactVersions.number, number),
      ),
    );
  if (!v) throw new AppError('not_found', `Version ${number} of ${artifactId} does not exist.`);
  return v;
}

async function setVersionState(ctx: CommandContext, artifactId: string, number: number, state: VersionState) {
  await ctx.tx
    .update(schema.artifactVersions)
    .set({ state, updatedAt: new Date() })
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
        eq(schema.artifactVersions.artifactId, artifactId),
        eq(schema.artifactVersions.number, number),
      ),
    );
}

async function publishVersion(ctx: CommandContext, artifactId: string, number: number) {
  const a = await loadArtifact(ctx, artifactId);
  if (a.publishedVersion && a.publishedVersion !== number) await setVersionState(ctx, artifactId, a.publishedVersion, 'superseded');
  await setVersionState(ctx, artifactId, number, 'published');
  await ctx.tx
    .update(schema.artifacts)
    .set({ publishedVersion: number, updatedAt: new Date() })
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, artifactId)));
}

export const listTypes = defineCommand({
  name: 'artifacts.types',
  title: 'List artifact types',
  description:
    'The artifact types this workspace supports, each with the JSON Schema its content must match. Read this before creating content.',
  input: z.object({}),
  output: z.object({
    types: z.array(z.object({ type: z.string(), label: z.string(), description: z.string(), contentSchema: z.unknown() })),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async () => ({
    types: Object.entries(artifactTypes).map(([type, t]) => ({
      type,
      label: t.label,
      description: t.description,
      contentSchema: z.toJSONSchema(t.content, { io: 'input' }),
    })),
  }),
});

export const createArtifact = defineCommand({
  name: 'artifacts.create',
  title: 'Create artifact draft',
  description:
    'Create a new artifact (journey, note, …) as version 1 in draft state. Nothing is live until it is published with artifacts.requestPublish.',
  input: z.object({
    type: artifactTypeEnum,
    name: z.string().min(1).max(120),
    content: z.unknown().describe('Content matching the type schema from artifacts.types'),
    note: z.string().max(500).optional().describe('Why this change was made, shown to reviewers'),
  }),
  output: z.object({ artifactId: z.string(), version: z.number().int(), state: VersionStateSchema }),
  permission: 'artifacts:write',
  effect: 'write',
  handler: async (input, ctx) => {
    const content = validateContent(input.type, input.content);
    const id = newId(artifactTypes[input.type].prefix);
    const ws = ctx.principal.workspaceId;
    if ('singleton' in artifactTypes[input.type]) {
      const [existing] = await ctx.tx
        .select({ id: schema.artifacts.id })
        .from(schema.artifacts)
        .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.type, input.type)));
      if (existing)
        throw new AppError('conflict', `A workspace has one ${input.type}; it is ${existing.id}. Edit it with artifacts.updateDraft.`);
    }
    await ctx.tx.insert(schema.artifacts).values({ workspaceId: ws, id, type: input.type, name: input.name, latestVersion: 1 });
    await ctx.tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: id,
      number: 1,
      state: 'draft',
      content,
      contentHash: hashValue(content),
      note: input.note ?? null,
      ...author(ctx),
    });
    return { artifactId: id, version: 1, state: 'draft' as const };
  },
});

export const updateDraft = defineCommand({
  name: 'artifacts.updateDraft',
  title: 'Update artifact draft',
  description:
    'Replace the content of an artifact. Edits the current draft, or starts a new draft version when the latest version is published, in review or rejected. Pass `expectedContentHash` (from artifacts.get) to avoid overwriting someone else’s concurrent edit.',
  input: z.object({
    artifactId: ArtifactId,
    content: z.unknown(),
    name: z.string().min(1).max(120).optional(),
    note: z.string().max(500).optional(),
    expectedContentHash: z
      .string()
      .optional()
      .describe('Content hash of the version you edited; the update fails with 412 if the draft changed since'),
  }),
  output: z.object({ artifactId: z.string(), version: z.number().int(), state: VersionStateSchema, contentHash: z.string() }),
  permission: 'artifacts:write',
  effect: 'write',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    const content = validateContent(a.type as ArtifactType, input.content);
    const latest = await loadVersion(ctx, a.id, a.latestVersion);
    if (input.expectedContentHash && input.expectedContentHash !== latest.contentHash)
      throw new AppError(
        'precondition_failed',
        `Version ${latest.number} changed since you read it. Reload it with artifacts.get and apply your change again.`,
      );
    const contentHash = hashValue(content);
    const ws = ctx.principal.workspaceId;
    if (input.name)
      await ctx.tx
        .update(schema.artifacts)
        .set({ name: input.name })
        .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, a.id)));

    if (latest.state === 'draft') {
      await ctx.tx
        .update(schema.artifactVersions)
        .set({ content, contentHash, note: input.note ?? latest.note, updatedAt: new Date(), ...author(ctx) })
        .where(
          and(
            eq(schema.artifactVersions.workspaceId, ws),
            eq(schema.artifactVersions.artifactId, a.id),
            eq(schema.artifactVersions.number, latest.number),
          ),
        );
      await ctx.tx
        .update(schema.artifacts)
        .set({ updatedAt: new Date() })
        .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, a.id)));
      return { artifactId: a.id, version: latest.number, state: 'draft' as const, contentHash };
    }
    const number = latest.number + 1;
    await ctx.tx.insert(schema.artifactVersions).values({
      workspaceId: ws,
      artifactId: a.id,
      number,
      state: 'draft',
      content,
      contentHash,
      basedOn: latest.number,
      note: input.note ?? null,
      ...author(ctx),
    });
    await ctx.tx
      .update(schema.artifacts)
      .set({ latestVersion: number, updatedAt: new Date() })
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, a.id)));
    return { artifactId: a.id, version: number, state: 'draft' as const, contentHash };
  },
});

export const getArtifact = defineCommand({
  name: 'artifacts.get',
  title: 'Get artifact',
  description: 'Read an artifact with the content of one version (default: the latest).',
  input: z.object({ artifactId: ArtifactId, version: z.number().int().positive().optional() }),
  output: z.object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    latestVersion: z.number().int(),
    publishedVersion: z.number().int().nullable(),
    version: VersionSummary.extend({ content: z.unknown() }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    const v = await loadVersion(ctx, a.id, input.version ?? a.latestVersion);
    return {
      id: a.id,
      type: a.type,
      name: a.name,
      latestVersion: a.latestVersion,
      publishedVersion: a.publishedVersion,
      version: { ...toSummary(v), content: v.content },
    };
  },
});

export const listArtifacts = defineCommand({
  name: 'artifacts.list',
  title: 'List artifacts',
  description: 'List artifacts in this workspace, newest first, optionally filtered by type.',
  input: z.object({ type: artifactTypeEnum.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({
    artifacts: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        name: z.string(),
        latestVersion: z.number().int(),
        latestState: VersionStateSchema,
        publishedVersion: z.number().int().nullable(),
        updatedAt: z.string(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  // Workspace scoping comes from row-level security; there is deliberately no workspace filter here.
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({ a: schema.artifacts, state: schema.artifactVersions.state })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
        ),
      )
      .where(input.type ? eq(schema.artifacts.type, input.type) : undefined)
      .orderBy(desc(schema.artifacts.updatedAt))
      .limit(input.limit);
    return {
      artifacts: rows.map(({ a, state }) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        latestVersion: a.latestVersion,
        latestState: state,
        publishedVersion: a.publishedVersion,
        updatedAt: a.updatedAt.toISOString(),
      })),
    };
  },
});

export const history = defineCommand({
  name: 'artifacts.history',
  title: 'Artifact version history',
  description: 'All versions of an artifact with state, author and note, newest first.',
  input: z.object({ artifactId: ArtifactId }),
  output: z.object({ versions: z.array(VersionSummary) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    await loadArtifact(ctx, input.artifactId);
    const rows = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId), eq(schema.artifactVersions.artifactId, input.artifactId)),
      )
      .orderBy(desc(schema.artifactVersions.number));
    return { versions: rows.map(toSummary) };
  },
});

export const diff = defineCommand({
  name: 'artifacts.diff',
  title: 'Diff two versions',
  description:
    'Structural difference between two versions of an artifact (default: published → latest). Lists added, removed and changed fields.',
  input: z.object({ artifactId: ArtifactId, from: z.number().int().positive().optional(), to: z.number().int().positive().optional() }),
  output: z.object({
    from: z.number().int().nullable(),
    to: z.number().int(),
    changes: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(['added', 'removed', 'changed']),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    const fromN = input.from ?? a.publishedVersion;
    const toN = input.to ?? a.latestVersion;
    const before = fromN ? (await loadVersion(ctx, a.id, fromN)).content : {};
    const after = (await loadVersion(ctx, a.id, toN)).content;
    return { from: fromN ?? null, to: toN, changes: diffJson(before, after) };
  },
});

export const requestPublish = defineCommand({
  name: 'artifacts.requestPublish',
  title: 'Publish (or request approval)',
  description:
    'Publish the latest draft. Under the workspace approval policy this either publishes immediately or puts the version in review and creates an approval request for a person.',
  input: z.object({ artifactId: ArtifactId, note: z.string().min(1).max(1000).describe('What changed and why, for the reviewer') }),
  output: z.object({
    status: z.enum(['published', 'in_review']),
    version: z.number().int(),
    approvalId: z.string().nullable(),
    policy: z.string(),
  }),
  permission: 'artifacts:publish',
  effect: 'publish',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    const v = await loadVersion(ctx, a.id, a.latestVersion);
    if (v.state !== 'draft')
      throw new AppError(
        'conflict',
        `The latest version (v${v.number}) is ${v.state.replace('_', ' ')}, not a draft. Edit it first to create a new draft.`,
      );
    const [w] = await ctx.tx
      .select({ policy: schema.workspaces.approvalPolicy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    const needsApproval =
      w.policy === 'all_publishes' || (w.policy === 'agent_changes' && (ctx.principal.type === 'agent' || v.authorType === 'agent'));
    if (!needsApproval) {
      await publishVersion(ctx, a.id, v.number);
      return { status: 'published' as const, version: v.number, approvalId: null, policy: w.policy };
    }
    const approvalId = newId('apr');
    await setVersionState(ctx, a.id, v.number, 'in_review');
    await ctx.tx.insert(schema.approvalRequests).values({
      workspaceId: ctx.principal.workspaceId,
      id: approvalId,
      artifactId: a.id,
      version: v.number,
      status: 'pending',
      requestedByType: ctx.principal.type,
      requestedById: ctx.principal.userId,
      requestedByClient: ctx.principal.clientId ?? null,
      note: input.note,
    });
    return { status: 'in_review' as const, version: v.number, approvalId, policy: w.policy };
  },
});

const Approval = z.object({
  id: z.string(),
  artifactId: z.string(),
  artifactName: z.string(),
  artifactType: z.string(),
  version: z.number().int(),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  requestedBy: Author,
  note: z.string(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
});

export const listApprovals = defineCommand({
  name: 'approvals.list',
  title: 'List approval requests',
  description: 'Approval requests in this workspace (default: pending), oldest first.',
  input: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ approvals: z.array(Approval) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({ r: schema.approvalRequests, name: schema.artifacts.name, type: schema.artifacts.type })
      .from(schema.approvalRequests)
      .innerJoin(
        schema.artifacts,
        and(
          eq(schema.artifacts.workspaceId, schema.approvalRequests.workspaceId),
          eq(schema.artifacts.id, schema.approvalRequests.artifactId),
        ),
      )
      .where(eq(schema.approvalRequests.status, input.status))
      .orderBy(schema.approvalRequests.createdAt)
      .limit(input.limit);
    return {
      approvals: rows.map(({ r, name, type }) => ({
        id: r.id,
        artifactId: r.artifactId,
        artifactName: name,
        artifactType: type,
        version: r.version,
        status: r.status,
        requestedBy: { type: r.requestedByType, id: r.requestedById, client: r.requestedByClient },
        note: r.note,
        decidedBy: r.decidedBy,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

async function decide(ctx: CommandContext, approvalId: string) {
  const [r] = await ctx.tx
    .select()
    .from(schema.approvalRequests)
    .where(and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), eq(schema.approvalRequests.id, approvalId)));
  if (!r) throw new AppError('not_found', `Approval request ${approvalId} does not exist.`);
  if (r.status !== 'pending') throw new AppError('conflict', `This request was already ${r.status}.`);
  const [w] = await ctx.tx
    .select({ policy: schema.workspaces.approvalPolicy })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
  // Four-eyes: under "all_publishes" a person cannot approve their own request. Agent requests can
  // be approved by the person the agent acted for — that is the point of reviewing agent work.
  if (w.policy === 'all_publishes' && r.requestedByType === 'user' && r.requestedById === ctx.principal.userId)
    throw new AppError(
      'forbidden',
      'You requested this change, so someone else must approve it (workspace policy: every publish needs approval).',
    );
  return r;
}

export const approve = defineCommand({
  name: 'approvals.approve',
  title: 'Approve and publish',
  description: 'Approve a pending request and publish that version. Only people can approve.',
  input: z.object({ approvalId: z.string(), note: z.string().max(1000).optional() }),
  output: z.object({ status: z.literal('approved'), artifactId: z.string(), version: z.number().int() }),
  permission: 'artifacts:approve',
  effect: 'publish',
  humansOnly: true,
  target: (i) => i.approvalId,
  handler: async (input, ctx) => {
    const r = await decide(ctx, input.approvalId);
    await publishVersion(ctx, r.artifactId, r.version);
    await ctx.tx
      .update(schema.approvalRequests)
      .set({ status: 'approved', decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: input.note ?? null })
      .where(and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), eq(schema.approvalRequests.id, r.id)));
    return { status: 'approved' as const, artifactId: r.artifactId, version: r.version };
  },
});

export const reject = defineCommand({
  name: 'approvals.reject',
  title: 'Reject a change',
  description: 'Reject a pending request. The version stays in history as rejected; editing the artifact starts a new draft.',
  input: z.object({ approvalId: z.string(), note: z.string().min(1).max(1000).describe('Tell the author what to change') }),
  output: z.object({ status: z.literal('rejected'), artifactId: z.string(), version: z.number().int() }),
  permission: 'artifacts:approve',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.approvalId,
  handler: async (input, ctx) => {
    const r = await decide(ctx, input.approvalId);
    await setVersionState(ctx, r.artifactId, r.version, 'rejected');
    await ctx.tx
      .update(schema.approvalRequests)
      .set({ status: 'rejected', decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: input.note })
      .where(and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), eq(schema.approvalRequests.id, r.id)));
    return { status: 'rejected' as const, artifactId: r.artifactId, version: r.version };
  },
});

export const artifactCommands = [
  listTypes,
  createArtifact,
  updateDraft,
  getArtifact,
  listArtifacts,
  history,
  diff,
  requestPublish,
  listApprovals,
  approve,
  reject,
] as const;

/** Content of the published version of a workspace's singleton artifact (tracking plan, purposes), if any. */
export async function publishedSingleton<T extends 'tracking_plan' | 'purposes'>(
  tx: CommandContext['tx'],
  type: T,
): Promise<z.output<(typeof artifactTypes)[T]['content']> | null> {
  const [row] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.type, type));
  return row ? (artifactTypes[type].content.parse(row.content) as never) : null;
}
