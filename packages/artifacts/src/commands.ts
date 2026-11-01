import { type ActionClass, type CommandContext, defineCommand, type Impact, recordAgentAction } from '@agentic-marketing/commands';
import { AppError, canonicalJson, hashValue, newId } from '@agentic-marketing/core';
import { type AgentUndo, schema, type VersionState } from '@agentic-marketing/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { diffJson } from './diff';
import { noteWithPolicy, publishImpact } from './impact';
import { holdWindowMs } from './mandates';
import {
  ARTIFACT_TYPES,
  type ArtifactType,
  artifactTypeEnum,
  artifactTypes,
  contentValidators,
  draftContentSchemas,
  publishValidators,
  referencesOf,
} from './types';

// Generic, versioned artifacts with a configurable approval pipeline (journeys-and-editors.md §5).
// Published versions are immutable; edits always produce or update a draft.

const ArtifactId = z
  .string()
  .regex(/^[a-z]{2,5}_[0-9a-f]{32}$/)
  .describe('Artifact id, e.g. "jrn_0192…"');
const VersionStateSchema = z.enum(['draft', 'in_review', 'published', 'superseded', 'rejected']);
const Author = z.object({ type: z.enum(['user', 'agent']), id: z.string(), client: z.string().nullable() });
export const Requester = z.object({
  kind: z.enum(['person', 'token', 'oauth_client']),
  displayName: z.string(),
  personName: z.string().nullable(),
  tokenName: z.string().nullable(),
  tokenId: z.string().nullable(),
  clientName: z.string().nullable(),
});

const VersionSummary = z.object({
  number: z.number().int(),
  state: VersionStateSchema,
  author: Author,
  by: Requester.optional().describe('Who wrote this version: person, API token (with owner) or OAuth client'),
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
export const author = (ctx: CommandContext) => ({
  authorType: ctx.principal.type,
  authorId: ctx.principal.userId,
  authorClient: ctx.principal.clientId ?? null,
});

export type DraftWarning = { nodeId: string | null; path: string; message: string };
const DraftWarningSchema = z.object({ nodeId: z.string().nullable(), path: z.string(), message: z.string() });

/** The admin UI page for an approval request (only SERVICES with a public URL can build absolute links). */
const approvalUrl = (publicUrl: string | undefined, approvalId: string) => (publicUrl ? `${publicUrl}/approvals/${approvalId}` : null);

function pathText(path: PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text ? `${text}.${String(part)}` : String(part);
  }, '');
}

function pathParts(path: PropertyKey[]): (string | number)[] {
  return path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number');
}

/** Turns a schema issue into a message that names the step and field it belongs to. */
function describeIssue(issue: z.core.$ZodIssue, content: unknown): DraftWarning {
  const path = pathParts(issue.path);
  let nodeId: string | null = null;
  let nodeKind: string | null = null;
  const nodes = (content as { nodes?: unknown } | null)?.nodes;
  if (path[0] === 'nodes' && typeof path[1] === 'number' && Array.isArray(nodes)) {
    const node = nodes[path[1]] as { id?: unknown; kind?: unknown } | undefined;
    nodeId = typeof node?.id === 'string' ? node.id : null;
    nodeKind = typeof node?.kind === 'string' ? node.kind : null;
  }
  const text = pathText(path);
  const message = issue.message.startsWith('Node "')
    ? issue.message
    : nodeId
      ? `Node "${nodeId}"${nodeKind ? ` (${nodeKind})` : ''}: ${text ? `${text}: ` : ''}${issue.message}`
      : text
        ? `${text}: ${issue.message}`
        : issue.message;
  return { nodeId, path: text, message };
}

/** Advice for an incomplete draft: the full schema's issues, without stopping the save. */
export function contentWarnings(type: ArtifactType, content: unknown): DraftWarning[] {
  const parsed = (artifactTypes[type].content as z.ZodType).safeParse(content);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => describeIssue(issue, content));
}

export function validateContent(type: ArtifactType, content: unknown, mode: 'draft' | 'publish' = 'publish') {
  const schema = (mode === 'draft' ? draftContentSchemas.get(type) : undefined) ?? artifactTypes[type].content;
  const parsed = (schema as z.ZodType).safeParse(content);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => describeIssue(issue, content).message);
    throw new AppError(
      'invalid_input',
      `The content is not a valid ${type}: ${problems.join('; ')}. Call artifacts.types for the schema.`,
      z.treeifyError(parsed.error),
    );
  }
  const problems = contentValidators.get(type)?.(parsed.data) ?? [];
  if (problems.length) throw new AppError('invalid_input', `The content is not a valid ${type}: ${problems.join('; ')}`, { problems });
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

async function checkPublishable(ctx: CommandContext, type: string, content: unknown, artifactId: string) {
  const schema = artifactTypes[type as ArtifactType]?.content as z.ZodType | undefined;
  if (schema) {
    const parsed = schema.safeParse(content);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => describeIssue(issue, content).message);
      throw new AppError('invalid_input', `This ${type} cannot be published yet: ${problems.join('; ')}`, {
        problems,
        errors: z.treeifyError(parsed.error),
      });
    }
  }
  const problems =
    (await publishValidators.get(type as ArtifactType)?.(content, ctx.tx, {
      id: artifactId,
      type,
      workspaceId: ctx.principal.workspaceId,
    })) ?? [];
  if (problems.length) throw new AppError('invalid_input', `This ${type} cannot be published yet: ${problems.join('; ')}`, { problems });
}

/** Called after an artifact version is published (once committed), e.g. to drop caches of its type. */
export const publishListeners: ((ctx: CommandContext, artifact: { id: string; type: string; workspaceId: string }) => Promise<void>)[] = [];

/**
 * Called inside the publishing transaction, after the version is live, e.g. to move an editorial
 * topic to approved (#141). Because it runs in the same transaction, the change lands with the
 * publish or not at all; a bundle's dry run rolls it back with the rest.
 */
export const publishHooks: ((
  ctx: CommandContext,
  artifact: { id: string; type: string; workspaceId: string },
  version: number,
) => Promise<void>)[] = [];

async function publishVersion(ctx: CommandContext, artifactId: string, number: number) {
  const a = await loadArtifact(ctx, artifactId);
  await checkPublishable(ctx, a.type, (await loadVersion(ctx, artifactId, number)).content, artifactId);
  if (a.publishedVersion && a.publishedVersion !== number) await setVersionState(ctx, artifactId, a.publishedVersion, 'superseded');
  await setVersionState(ctx, artifactId, number, 'published');
  await ctx.tx
    .update(schema.artifacts)
    .set({ publishedVersion: number, updatedAt: new Date() })
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, artifactId)));
  const artifact = { id: artifactId, type: a.type, workspaceId: ctx.principal.workspaceId };
  for (const h of publishHooks) await h(ctx, artifact, number);
  for (const l of publishListeners) ctx.afterCommit ? ctx.afterCommit(() => l(ctx, artifact)) : await l(ctx, artifact);
}

/** Locks artifact rows (in id order) so their latest version cannot change until the transaction ends. */
async function lockArtifacts(ctx: CommandContext, ids: string[]) {
  await ctx.tx
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), inArray(schema.artifacts.id, ids)))
    .orderBy(asc(schema.artifacts.id))
    .for('update');
}

/** Publishes a version through the same checks and listeners as any other publish (agents.undo). */
export async function publishArtifactVersion(ctx: CommandContext, artifactId: string, number: number) {
  await publishVersion(ctx, artifactId, number);
}

/**
 * Takes the live version out of service again, for undoing a first publish: the version becomes
 * a draft and nothing of it is live (journeys stop entering people, experiences stop serving).
 * Returns the version that was unpublished, or null when nothing was live.
 */
export async function unpublishArtifactVersion(ctx: CommandContext, artifactId: string): Promise<number | null> {
  const a = await loadArtifact(ctx, artifactId);
  if (a.publishedVersion === null) return null;
  const number = a.publishedVersion;
  await setVersionState(ctx, artifactId, number, 'draft');
  await ctx.tx
    .update(schema.artifacts)
    .set({ publishedVersion: null, updatedAt: new Date() })
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, artifactId)));
  const artifact = { id: artifactId, type: a.type, workspaceId: ctx.principal.workspaceId };
  for (const l of publishListeners) ctx.afterCommit ? ctx.afterCommit(() => l(ctx, artifact)) : await l(ctx, artifact);
  return number;
}

/**
 * How to reverse publishing this artifact (ADR-0016 §5.4, #255): republish the version that was
 * live before, or unpublish a first publish. A broadcast also cancels its scheduled send; once it
 * has gone out, the ledger says plainly that messages cannot be recalled.
 */
export async function publishUndo(
  ctx: Pick<CommandContext, 'tx' | 'principal'>,
  member: { id: string; type: string },
  previousVersion: number | null,
  publishedVersion: number,
): Promise<AgentUndo> {
  // The version the agent published is kept, so an undo can tell when newer work went live (#281).
  const republish: AgentUndo = { kind: 'republish', artifactId: member.id, previousVersion, publishedVersion };
  if (member.type !== 'broadcast') return republish;
  const [run] = await ctx.tx
    .select({ status: schema.broadcastRuns.status })
    .from(schema.broadcastRuns)
    .where(and(eq(schema.broadcastRuns.workspaceId, ctx.principal.workspaceId), eq(schema.broadcastRuns.broadcastId, member.id)));
  if (run?.status === 'done') return { kind: 'none', reason: 'Messages already sent cannot be recalled.' };
  return { kind: 'group', items: [republish, { kind: 'cancel_send', broadcastId: member.id }] };
}

/** The reversal of publishing several artifacts together: one group, or a plain reversal for one. */
export async function publishUndoGroup(
  ctx: Pick<CommandContext, 'tx' | 'principal'>,
  members: { id: string; type: string; previousVersion: number | null; version: number }[],
): Promise<AgentUndo> {
  const items: AgentUndo[] = [];
  for (const m of members) items.push(await publishUndo(ctx, m, m.previousVersion, m.version));
  if (items.some((item) => item.kind === 'none')) return items.find((item) => item.kind === 'none')!;
  return items.length === 1 ? items[0] : { kind: 'group', items };
}

/**
 * The order to publish artifacts that refer to each other (#107): an artifact comes after every
 * other member its content names (a broadcast after its template, a form after its confirmation
 * template). Throws on a cycle.
 */
export function dependencyOrder<M extends { id: string; content: unknown }>(members: M[]): M[] {
  const ids = new Set(members.map((m) => m.id));
  const needs = new Map(
    members.map((m) => {
      const text = JSON.stringify(m.content);
      return [m.id, new Set([...ids].filter((other) => other !== m.id && text.includes(other)))];
    }),
  );
  const order: M[] = [];
  const remaining = [...members];
  while (remaining.length) {
    const i = remaining.findIndex((m) => [...needs.get(m.id)!].every((d) => order.some((o) => o.id === d)));
    if (i < 0)
      throw new AppError('invalid_input', `These artifacts refer to each other in a circle: ${remaining.map((m) => m.id).join(', ')}.`);
    order.push(...remaining.splice(i, 1));
  }
  return order;
}

/**
 * Checks that the members can be published together, by publishing them in order and then rolling
 * back to a savepoint: references inside the bundle resolve exactly as on approval, and nothing is
 * kept (publish listeners are not called). Commands run on one connection inside a manual BEGIN,
 * so this uses SAVEPOINT directly: drizzle's tx.transaction() would issue a second BEGIN, and its
 * rollback would end the command's whole transaction.
 */
async function checkBundlePublishable(ctx: CommandContext, ordered: { id: string; name: string; version: number }[]) {
  const dry: CommandContext = { ...ctx, afterCommit: () => {} };
  await ctx.tx.execute(sql`SAVEPOINT bundle_check`);
  try {
    for (const m of ordered) {
      try {
        await publishVersion(dry, m.id, m.version);
      } catch (err) {
        if (err instanceof AppError) throw new AppError(err.code, `“${m.name}” (${m.id}): ${err.message}`, err.details);
        throw err;
      }
    }
  } finally {
    await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT bundle_check`);
    await ctx.tx.execute(sql`RELEASE SAVEPOINT bundle_check`);
  }
}

export const listTypes = defineCommand({
  name: 'artifacts.types',
  title: 'List artifact types',
  description:
    'The artifact types this workspace supports, each with the JSON Schema its content must match. Pass type to get one type (the full list is large, about 66 KB); omit it for all. Read this before creating content.',
  input: z.object({
    type: z
      .enum(ARTIFACT_TYPES, `Unknown artifact type. Use one of: ${ARTIFACT_TYPES.join(', ')}.`)
      .optional()
      .describe('Return only this type; omit to return all types'),
  }),
  output: z.object({
    types: z.array(z.object({ type: z.string(), label: z.string(), description: z.string(), contentSchema: z.unknown() })),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input) => ({
    types: Object.entries(artifactTypes)
      .filter(([type]) => !input.type || type === input.type)
      .map(([type, t]) => ({
        type,
        label: t.label,
        description: t.description,
        contentSchema: z.toJSONSchema(t.content, { io: 'input' }),
      })),
  }),
});

/** Types only people may write, whatever an agent's scopes (agent mandates, ADR-0016). */
function refuseAgentsFor(ctx: CommandContext, type: string) {
  if (ctx.principal.type !== 'agent') return;
  const def = artifactTypes[type as ArtifactType] as { peopleOnly?: boolean; label: string } | undefined;
  if (def?.peopleOnly)
    throw new AppError(
      'forbidden',
      `Only people can create, change or publish ${def.label.toLowerCase()}s; agents cannot set their own borders.`,
    );
}

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
  output: z.object({
    artifactId: z.string(),
    version: z.number().int(),
    state: VersionStateSchema,
    warnings: z.array(DraftWarningSchema).describe('Settings that must be filled in before this artifact can be published'),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    refuseAgentsFor(ctx, input.type);
    const content = validateContent(input.type, input.content, 'draft');
    const warnings = contentWarnings(input.type, content);
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
    return { artifactId: id, version: 1, state: 'draft' as const, warnings };
  },
});

type Positions = Record<string, { x: number; y: number }>;

const LayoutSchema = z.object({
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).describe('Canvas position per step id'),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

/** A journey with its canvas positions removed: what must differ for a real new version. */
function withoutPositions(content: unknown): unknown {
  if (!content || typeof content !== 'object') return content;
  const nodes = (content as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return content;
  return {
    ...(content as Record<string, unknown>),
    nodes: nodes.map((node) => {
      if (!node || typeof node !== 'object') return node;
      const { position: _position, ...rest } = node as Record<string, unknown>;
      return rest;
    }),
  };
}

function positionsOf(content: unknown): Positions {
  const nodes = (content as { nodes?: unknown } | null)?.nodes;
  const out: Positions = {};
  if (!Array.isArray(nodes)) return out;
  for (const value of nodes) {
    const node = value as { id?: unknown; position?: { x?: unknown; y?: unknown } };
    if (typeof node.id === 'string' && typeof node.position?.x === 'number' && typeof node.position.y === 'number')
      out[node.id] = { x: node.position.x, y: node.position.y };
  }
  return out;
}

async function saveLayout(ctx: CommandContext, artifactId: string, positions: Positions) {
  await ctx.tx
    .insert(schema.artifactLayout)
    .values({ workspaceId: ctx.principal.workspaceId, artifactId, layout: positions, updatedBy: ctx.principal.userId })
    .onConflictDoUpdate({
      target: [schema.artifactLayout.workspaceId, schema.artifactLayout.artifactId],
      set: { layout: positions, updatedAt: new Date(), updatedBy: ctx.principal.userId },
    });
}

export const updateDraft = defineCommand({
  name: 'artifacts.updateDraft',
  title: 'Update artifact draft',
  description:
    'Replace the content of an artifact. Edits the current draft, or starts a new draft version when the latest version is published, in review or rejected. A journey edit that only moves steps is saved as layout and creates no version. Pass `expectedContentHash` (from artifacts.get) to avoid overwriting someone else’s concurrent edit.',
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
  output: z.object({
    artifactId: z.string(),
    version: z.number().int(),
    state: VersionStateSchema,
    contentHash: z.string(),
    layoutOnly: z.boolean().describe('True when only step positions changed, so no version was created'),
    warnings: z.array(DraftWarningSchema).describe('Settings that must be filled in before this artifact can be published'),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    refuseAgentsFor(ctx, a.type);
    const content = validateContent(a.type as ArtifactType, input.content, 'draft');
    const warnings = contentWarnings(a.type as ArtifactType, content);
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

    // Moving steps is layout, not content: store it beside the version and leave the draft alone.
    // Canonical JSON ignores key order, so without positions this compares only real content.
    const layoutOnly =
      a.type === 'journey' &&
      canonicalJson(content) !== canonicalJson(latest.content) &&
      canonicalJson(withoutPositions(content)) === canonicalJson(withoutPositions(latest.content));
    if (layoutOnly) {
      await saveLayout(ctx, a.id, positionsOf(content));
      return {
        artifactId: a.id,
        version: latest.number,
        state: latest.state,
        contentHash: latest.contentHash,
        layoutOnly: true,
        warnings,
      };
    }

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
      if (a.type === 'journey') await saveLayout(ctx, a.id, positionsOf(content));
      return { artifactId: a.id, version: latest.number, state: 'draft' as const, contentHash, layoutOnly: false, warnings };
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
    if (a.type === 'journey') await saveLayout(ctx, a.id, positionsOf(content));
    return { artifactId: a.id, version: number, state: 'draft' as const, contentHash, layoutOnly: false, warnings };
  },
});

export const getArtifact = defineCommand({
  name: 'artifacts.get',
  title: 'Get artifact',
  description:
    'Read an artifact with the content of one version (default: the latest). `layout` holds canvas positions for the builder; agents never need it to edit a journey.',
  input: z.object({ artifactId: ArtifactId, version: z.number().int().positive().optional() }),
  output: z.object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    latestVersion: z.number().int(),
    publishedVersion: z.number().int().nullable(),
    version: VersionSummary.extend({ content: z.unknown() }),
    layout: LayoutSchema.nullable().describe('Saved canvas layout, when a person has moved steps; otherwise null'),
    references: z
      .array(z.string())
      .describe('Ids this version refers to, e.g. the block ids an e-mail template uses; empty for most types'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    const v = await loadVersion(ctx, a.id, input.version ?? a.latestVersion);
    const [layout] = await ctx.tx
      .select()
      .from(schema.artifactLayout)
      .where(and(eq(schema.artifactLayout.workspaceId, ctx.principal.workspaceId), eq(schema.artifactLayout.artifactId, a.id)));
    return {
      id: a.id,
      type: a.type,
      name: a.name,
      latestVersion: a.latestVersion,
      publishedVersion: a.publishedVersion,
      version: { ...(await withAuthorNames(ctx, [toSummary(v)]))[0]!, content: v.content },
      layout: layout
        ? {
            positions: layout.layout as Positions,
            updatedAt: layout.updatedAt.toISOString(),
            updatedBy: layout.updatedBy,
          }
        : null,
      references: referencesOf(a.type, v.content),
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
    return { versions: await withAuthorNames(ctx, rows.map(toSummary)) };
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
    layoutOnly: z.boolean().describe('True when every change is a step position (for example an old draft made by moving steps)'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    const fromN = input.from ?? a.publishedVersion;
    const toN = input.to ?? a.latestVersion;
    const before = fromN ? (await loadVersion(ctx, a.id, fromN)).content : {};
    const after = (await loadVersion(ctx, a.id, toN)).content;
    const changes = diffJson(before, after);
    const layoutOnly = changes.length > 0 && changes.every((c) => /^nodes\[[^\]]+\]\.position(\.|$)/.test(c.path));
    return { from: fromN ?? null, to: toN, changes, layoutOnly };
  },
});

export const discardDraft = defineCommand({
  name: 'artifacts.discardDraft',
  title: 'Discard draft',
  description:
    'Delete the unpublished versions after the live one and return the artifact to its live version. Refuses when nothing is live, there is no draft, or the draft is waiting for approval.',
  input: z.object({ artifactId: ArtifactId }),
  output: z.object({
    artifactId: z.string(),
    version: z.number().int().describe('The live version this artifact is back on'),
    state: z.literal('published'),
    discardedVersions: z.array(z.number().int()),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    refuseAgentsFor(ctx, a.type);
    if (!a.publishedVersion) throw new AppError('conflict', 'This artifact has no live version, so there is nothing to go back to.');
    const ws = ctx.principal.workspaceId;
    const versions = await ctx.tx
      .select({ number: schema.artifactVersions.number })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.workspaceId, ws), eq(schema.artifactVersions.artifactId, a.id)))
      .orderBy(desc(schema.artifactVersions.number));
    const discarded = versions.filter((v) => v.number > a.publishedVersion!).map((v) => v.number);
    if (discarded.length === 0) throw new AppError('conflict', 'There is no draft to discard.');
    // A pending request points at one of these versions; the reviewer must reject it
    // first, otherwise an approval could publish a version that no longer exists.
    const [pending] = await ctx.tx
      .select({ version: schema.approvalRequests.version })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ws),
          eq(schema.approvalRequests.artifactId, a.id),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    if (pending)
      throw new AppError(
        'conflict',
        `Version ${pending.version} is waiting for approval. Reject that request before discarding the draft.`,
      );
    // The app role cannot delete versions; this function deletes exactly the drafts after the live
    // version (migration 0031) and moves the artifact back to it.
    await ctx.tx.execute(sql`SELECT discard_artifact_drafts(${a.id})`);
    return { artifactId: a.id, version: a.publishedVersion, state: 'published' as const, discardedVersions: discarded };
  },
});

/** When a held agent change (level 2) runs unless vetoed, or null when it is not held. */
function holdFor(ctx: CommandContext): Date | null {
  if (ctx.policy?.decision !== 'hold') return null;
  return new Date(Date.now() + holdWindowMs(ctx.policy.mandate?.holdWindow ?? 'PT2H'));
}

export const requestPublish = defineCommand({
  name: 'artifacts.requestPublish',
  title: 'Submit for review (or publish)',
  description:
    "Submits the latest draft for review under the workspace approval policy; publishes directly only when the policy allows it (policy `none`, or `agent_changes` for a person's own edits). A person then approves or rejects it in the admin UI. Check the result with approvals.list or artifacts.get.",
  input: z.object({ artifactId: ArtifactId, note: z.string().min(1).max(1000).describe('What changed and why, for the reviewer') }),
  output: z.object({
    status: z
      .enum(['published', 'in_review', 'on_hold'])
      .describe('on_hold: an agent change that runs at runsAt unless a person vetoes it'),
    version: z.number().int(),
    runsAt: z.string().nullable().optional().describe('For on_hold: when it runs unless a person rejects it'),
    approvalId: z.string().nullable(),
    policy: z.string(),
    reviewUrl: z.string().nullable().describe('Admin UI page where a person approves this; null when it was published directly'),
    next: z.string().describe('What happens next, and how to check the result'),
    heldBecause: z
      .array(z.string())
      .optional()
      .describe(
        'Why the agent policy sent this to a person even though the approval policy would not have (audience threshold, limits, propose-only)',
      ),
  }),
  permission: 'artifacts:publish',
  effect: 'publish',
  actionClass: 'content.publish',
  approvable: true,
  impact: async (input, ctx) => {
    // Locked until the handler publishes: the independent check reviews the version that goes live (#283).
    await lockArtifacts(ctx, [input.artifactId]);
    const a = await loadArtifact(ctx, input.artifactId);
    return publishImpact(ctx, [{ id: a.id, type: a.type, version: a.latestVersion }]);
  },
  // The approval this action created, so the shadow report attributes a person's decision to it (#286).
  ledgerImpact: (out) => (out.approvalId ? { approvalId: out.approvalId } : undefined),
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const a = await loadArtifact(ctx, input.artifactId);
    refuseAgentsFor(ctx, a.type);
    const v = await loadVersion(ctx, a.id, a.latestVersion);
    if (v.state !== 'draft')
      throw new AppError(
        'conflict',
        `The latest version (v${v.number}) is ${v.state.replace('_', ' ')}, not a draft. Edit it first to create a new draft.`,
      );
    await checkPublishable(ctx, a.type, v.content, a.id);
    const [w] = await ctx.tx
      .select({ policy: schema.workspaces.approvalPolicy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    const needsApproval =
      w.policy === 'all_publishes' ||
      (w.policy === 'agent_changes' && (ctx.principal.type === 'agent' || v.authorType === 'agent')) ||
      ctx.policy?.decision === 'ask';
    // A mandate decides for its agent (ADR-0016): level 3 publishes without the approval policy,
    // level 2 waits for a veto window.
    const hold = holdFor(ctx);
    const autonomous = ctx.policy?.decision === 'allow' && ctx.policy.autonomous === true;
    if (autonomous || (!needsApproval && !hold)) {
      await publishVersion(ctx, a.id, v.number);
      ctx.undo?.set(await publishUndo(ctx, a, a.publishedVersion, v.number));
      return {
        status: 'published' as const,
        version: v.number,
        approvalId: null,
        policy: w.policy,
        reviewUrl: null,
        next: `Published as v${v.number}; it is live now.`,
      };
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
      note: noteWithPolicy(input.note, ctx),
      holdUntil: hold,
    });
    const reviewUrl = approvalUrl(ctx.services.publicUrl, approvalId);
    return {
      ...(ctx.policy?.decision === 'ask' || hold ? { heldBecause: ctx.policy?.reasons ?? [] } : {}),
      status: hold ? ('on_hold' as const) : ('in_review' as const),
      runsAt: hold?.toISOString() ?? null,
      version: v.number,
      approvalId,
      policy: w.policy,
      reviewUrl,
      next: hold
        ? `Held: it publishes at ${hold.toISOString()} unless a person rejects it${reviewUrl ? ` (${reviewUrl})` : ''}. Check the result with artifacts.get.`
        : reviewUrl
          ? `A person must approve this in the admin UI: ${reviewUrl}. Check the result with approvals.list or artifacts.get.`
          : 'A person must approve this in the admin UI. Check the result with approvals.list or artifacts.get.',
    };
  },
});

export const requestPublishBundle = defineCommand({
  name: 'artifacts.requestPublishBundle',
  title: 'Submit several artifacts for one review',
  description:
    "Submits the latest drafts of artifacts that belong together for ONE review, e.g. this week's e-mail template and the broadcast that sends it, or a form and its confirmation template. References between them are checked as if they were already published; a person approves or rejects them together, and approval publishes them in dependency order in one step (all or nothing). Publishes directly when the approval policy allows it. Use it instead of two requestPublish rounds whenever one artifact refers to another unpublished one.",
  input: z.object({
    artifactIds: z.array(ArtifactId).min(2).max(10).describe('The artifacts to publish together, in any order'),
    note: z.string().min(1).max(1000).describe('What changed and why, for the reviewer'),
  }),
  output: z.object({
    status: z.enum(['published', 'in_review', 'on_hold']).describe('on_hold: agent changes that run at runsAt unless a person vetoes them'),
    bundleId: z.string().nullable(),
    runsAt: z.string().nullable().optional().describe('For on_hold: when they run unless a person rejects them'),
    members: z
      .array(
        z.object({
          artifactId: z.string(),
          name: z.string(),
          type: z.string(),
          version: z.number().int(),
          approvalId: z.string().nullable(),
        }),
      )
      .describe('In the order they are published'),
    policy: z.string(),
    reviewUrl: z.string().nullable().describe('Admin UI page where a person reviews the whole bundle; null when it was published directly'),
    next: z.string(),
    heldBecause: z
      .array(z.string())
      .optional()
      .describe('Why the agent policy sent this to a person (audience threshold, limits, propose-only)'),
  }),
  permission: 'artifacts:publish',
  effect: 'publish',
  actionClass: 'content.publish',
  approvable: true,
  impact: async (input, ctx) => {
    await lockArtifacts(ctx, [...new Set(input.artifactIds)]);
    const members = [];
    for (const id of new Set(input.artifactIds)) {
      const a = await loadArtifact(ctx, id);
      members.push({ id: a.id, type: a.type, version: a.latestVersion });
    }
    return publishImpact(ctx, members);
  },
  ledgerImpact: (out) => {
    const ids = out.members.map((m) => m.approvalId).filter((id): id is string => !!id);
    return ids.length ? { approvalId: ids[0], bundleId: out.bundleId } : undefined;
  },
  target: (i) => i.artifactIds.join(','),
  handler: async (input, ctx) => {
    const ids = [...new Set(input.artifactIds)];
    if (ids.length < 2)
      throw new AppError('invalid_input', 'A bundle needs at least two different artifacts; use artifacts.requestPublish for one.');
    const members = [];
    for (const id of ids) {
      const a = await loadArtifact(ctx, id);
      refuseAgentsFor(ctx, a.type);
      const v = await loadVersion(ctx, a.id, a.latestVersion);
      if (v.state !== 'draft')
        throw new AppError(
          'conflict',
          `The latest version of “${a.name}” (v${v.number}) is ${v.state.replace('_', ' ')}, not a draft. Edit it first to create a new draft.`,
        );
      members.push({
        id: a.id,
        name: a.name,
        type: a.type,
        version: v.number,
        content: v.content,
        authorType: v.authorType,
        previousVersion: a.publishedVersion,
      });
    }
    const ordered = dependencyOrder(members);
    await checkBundlePublishable(ctx, ordered);
    const [w] = await ctx.tx
      .select({ policy: schema.workspaces.approvalPolicy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    const needsApproval =
      w.policy === 'all_publishes' ||
      (w.policy === 'agent_changes' && (ctx.principal.type === 'agent' || ordered.some((m) => m.authorType === 'agent'))) ||
      ctx.policy?.decision === 'ask';
    const hold = holdFor(ctx);
    const autonomous = ctx.policy?.decision === 'allow' && ctx.policy.autonomous === true;
    const out = (approvalIds: (string | null)[]) =>
      ordered.map((m, i) => ({ artifactId: m.id, name: m.name, type: m.type, version: m.version, approvalId: approvalIds[i] }));
    if (autonomous || (!needsApproval && !hold)) {
      for (const m of ordered) await publishVersion(ctx, m.id, m.version);
      ctx.undo?.set(
        await publishUndoGroup(
          ctx,
          ordered.map((m) => ({ id: m.id, type: m.type, previousVersion: m.previousVersion, version: m.version })),
        ),
      );
      return {
        status: 'published' as const,
        bundleId: null,
        members: out(ordered.map(() => null)),
        policy: w.policy,
        reviewUrl: null,
        next: `Published ${ordered.map((m) => `“${m.name}” v${m.version}`).join(', ')}; they are live now.`,
      };
    }
    const bundleId = newId('apb');
    const approvalIds = ordered.map(() => newId('apr'));
    for (const [i, m] of ordered.entries()) {
      await setVersionState(ctx, m.id, m.version, 'in_review');
      await ctx.tx.insert(schema.approvalRequests).values({
        workspaceId: ctx.principal.workspaceId,
        id: approvalIds[i],
        artifactId: m.id,
        version: m.version,
        status: 'pending',
        requestedByType: ctx.principal.type,
        requestedById: ctx.principal.userId,
        requestedByClient: ctx.principal.clientId ?? null,
        note: noteWithPolicy(input.note, ctx),
        bundleId,
        holdUntil: hold,
      });
    }
    // The last member is the one the others exist for (the broadcast, the form): open on it.
    const reviewUrl = approvalUrl(ctx.services.publicUrl, approvalIds.at(-1)!);
    return {
      ...(ctx.policy?.decision === 'ask' || hold ? { heldBecause: ctx.policy?.reasons ?? [] } : {}),
      status: hold ? ('on_hold' as const) : ('in_review' as const),
      runsAt: hold?.toISOString() ?? null,
      bundleId,
      members: out(approvalIds),
      policy: w.policy,
      reviewUrl,
      next: hold
        ? `Held: all ${ordered.length} publish together at ${hold.toISOString()} unless a person rejects them${reviewUrl ? ` (${reviewUrl})` : ''}. Check the result with artifacts.get.`
        : `A person reviews all ${ordered.length} together${reviewUrl ? ` in the admin UI: ${reviewUrl}` : ' in the admin UI'}; approving publishes them in this order. Check the result with approvals.list or artifacts.get.`,
    };
  },
});

const BundleMember = z.object({
  approvalId: z.string(),
  artifactId: z.string(),
  artifactName: z.string(),
  artifactType: z.string(),
  version: z.number().int(),
});

const Approval = z.object({
  id: z.string(),
  artifactId: z.string(),
  artifactName: z.string(),
  artifactType: z.string(),
  version: z.number().int(),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  requestedBy: Author,
  requester: Requester,
  note: z.string(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  holdUntil: z
    .string()
    .nullable()
    .describe('When a held agent change runs unless a person vetoes it (null: an ordinary review); a person may run or veto it before'),

  artifactLatestVersion: z.number().int(),
  artifactPublishedVersion: z.number().int().nullable(),
  reviewUrl: z.string().nullable().describe('Admin UI page for this approval request'),
  bundle: z
    .object({ id: z.string(), members: z.array(BundleMember).describe('In the order they are published') })
    .nullable()
    .describe('Set when this request is reviewed together with others (artifacts.requestPublishBundle): deciding one decides all'),
});

type ApprovalRow = typeof schema.approvalRequests.$inferSelect;
type ArtifactRow = typeof schema.artifacts.$inferSelect;
type RequesterOut = z.output<typeof Requester>;

/** People and OAuth-client names live in the auth tables (provided by the auth package). */
interface ApprovalDirectory {
  users(ids: string[]): Promise<Map<string, { email: string; name: string }>>;
  oauthClients(clientIds: string[]): Promise<Map<string, string>>;
}

const directoryOf = (ctx: CommandContext) => (ctx.services as { directory?: ApprovalDirectory }).directory;

const nameOf = (p: { email: string; name: string } | undefined, fallback: string) => p?.name || p?.email || fallback;

/** Resolves raw requester ids to names: people, API tokens (with their owner) and OAuth clients. */
export interface ActorRef {
  key: string;
  type: 'user' | 'agent';
  id: string;
  client: string | null;
}

/** Resolves raw actor ids to names: people, API tokens (with their owner) and OAuth clients. */
export async function resolveActors(ctx: CommandContext, actors: ActorRef[]): Promise<Map<string, RequesterOut>> {
  const tokenIds = actors.filter((r) => r.type === 'agent' && r.client?.startsWith('token:')).map((r) => r.client!.slice('token:'.length));
  const clientIds = actors.filter((r) => r.type === 'agent' && r.client && !r.client.startsWith('token:')).map((r) => r.client!);
  const tokens = tokenIds.length
    ? await ctx.tx
        .select({ id: schema.apiTokens.id, name: schema.apiTokens.name, userId: schema.apiTokens.userId })
        .from(schema.apiTokens)
        .where(inArray(schema.apiTokens.id, [...new Set(tokenIds)]))
    : [];
  const tokenById = new Map(tokens.map((t) => [t.id, t]));
  const directory = directoryOf(ctx);
  const people = directory
    ? await directory.users([...new Set([...actors.map((r) => r.id), ...tokens.map((t) => t.userId)])])
    : new Map<string, { email: string; name: string }>();
  const clients = directory && clientIds.length ? await directory.oauthClients([...new Set(clientIds)]) : new Map<string, string>();

  const out = new Map<string, RequesterOut>();
  for (const r of actors) {
    const personName = nameOf(people.get(r.id), r.id);
    if (r.type === 'user') {
      out.set(r.key, { kind: 'person', displayName: personName, personName, tokenName: null, tokenId: null, clientName: null });
      continue;
    }
    const tokenId = r.client?.startsWith('token:') ? r.client.slice('token:'.length) : null;
    if (tokenId) {
      const token = tokenById.get(tokenId);
      const ownerName = nameOf(people.get(token?.userId ?? r.id), r.id);
      out.set(r.key, {
        kind: 'token',
        displayName: token?.name ? `${token.name} (${ownerName})` : ownerName,
        personName: ownerName,
        tokenName: token?.name ?? null,
        tokenId,
        clientName: null,
      });
      continue;
    }
    const clientName = (r.client && clients.get(r.client)) || null;
    out.set(r.key, { kind: 'oauth_client', displayName: clientName || personName, personName, tokenName: null, tokenId: null, clientName });
  }
  return out;
}

const resolveRequesters = (ctx: CommandContext, rows: ApprovalRow[]) =>
  resolveActors(
    ctx,
    rows.map((r) => ({ key: r.id, type: r.requestedByType, id: r.requestedById, client: r.requestedByClient })),
  );

/** Version summaries with the author's display name (`by`), for history and detail views. */
export async function withAuthorNames<V extends { number: number; author: { type: 'user' | 'agent'; id: string; client: string | null } }>(
  ctx: CommandContext,
  versions: V[],
): Promise<(V & { by: RequesterOut })[]> {
  const names = await resolveActors(
    ctx,
    versions.map((v) => ({ key: String(v.number), ...v.author })),
  );
  return versions.map((v) => ({ ...v, by: names.get(String(v.number))! }));
}

type Bundles = Map<string, z.output<typeof BundleMember>[]>;

/** The members of the given bundles, in publish order. */
async function bundlesOf(ctx: CommandContext, rows: ApprovalRow[]): Promise<Bundles> {
  const ids = [...new Set(rows.map((r) => r.bundleId).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const members = await ctx.tx
    .select({ r: schema.approvalRequests, a: schema.artifacts, content: schema.artifactVersions.content })
    .from(schema.approvalRequests)
    .innerJoin(
      schema.artifacts,
      and(
        eq(schema.artifacts.workspaceId, schema.approvalRequests.workspaceId),
        eq(schema.artifacts.id, schema.approvalRequests.artifactId),
      ),
    )
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.approvalRequests.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.approvalRequests.artifactId),
        eq(schema.artifactVersions.number, schema.approvalRequests.version),
      ),
    )
    .where(inArray(schema.approvalRequests.bundleId, ids));
  const out: Bundles = new Map();
  for (const id of ids) {
    const own = members.filter((m) => m.r.bundleId === id).map((m) => ({ id: m.a.id, content: m.content, m }));
    out.set(
      id,
      dependencyOrder(own).map(({ m }) => ({
        approvalId: m.r.id,
        artifactId: m.a.id,
        artifactName: m.a.name,
        artifactType: m.a.type,
        version: m.r.version,
      })),
    );
  }
  return out;
}

const approvalOut = (ctx: CommandContext, r: ApprovalRow, a: ArtifactRow, requester: RequesterOut, bundles: Bundles = new Map()) => ({
  id: r.id,
  artifactId: r.artifactId,
  artifactName: a.name,
  artifactType: a.type,
  version: r.version,
  status: r.status,
  requestedBy: { type: r.requestedByType, id: r.requestedById, client: r.requestedByClient },
  requester,
  note: r.note,
  decidedBy: r.decidedBy,
  decisionNote: r.decisionNote,
  createdAt: r.createdAt.toISOString(),
  holdUntil: r.holdUntil?.toISOString() ?? null,
  artifactLatestVersion: a.latestVersion,
  artifactPublishedVersion: a.publishedVersion,
  reviewUrl: approvalUrl(ctx.services.publicUrl, r.id),
  bundle: r.bundleId ? { id: r.bundleId, members: bundles.get(r.bundleId) ?? [] } : null,
});

export const listApprovals = defineCommand({
  name: 'approvals.list',
  title: 'List approval requests',
  description: 'Approval requests in this workspace (default: pending), oldest first, optionally for one artifact.',
  input: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
    limit: z.number().int().min(1).max(200).default(50),
    artifactId: ArtifactId.optional().describe('Only requests for this artifact'),
  }),
  output: z.object({ approvals: z.array(Approval) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({ r: schema.approvalRequests, a: schema.artifacts })
      .from(schema.approvalRequests)
      .innerJoin(
        schema.artifacts,
        and(
          eq(schema.artifacts.workspaceId, schema.approvalRequests.workspaceId),
          eq(schema.artifacts.id, schema.approvalRequests.artifactId),
        ),
      )
      .where(
        and(
          eq(schema.approvalRequests.status, input.status),
          input.artifactId ? eq(schema.approvalRequests.artifactId, input.artifactId) : undefined,
        ),
      )
      .orderBy(schema.approvalRequests.createdAt)
      .limit(input.limit);
    const requesters = await resolveRequesters(
      ctx,
      rows.map(({ r }) => r),
    );
    const bundles = await bundlesOf(
      ctx,
      rows.map(({ r }) => r),
    );
    return { approvals: rows.map(({ r, a }) => approvalOut(ctx, r, a, requesters.get(r.id)!, bundles)) };
  },
});

export const getApproval = defineCommand({
  name: 'approvals.get',
  title: 'Get an approval request',
  description:
    'An approval request with the version under review, the published version, a structural diff from the published version to the reviewed one, and the decision history.',
  input: z.object({ approvalId: z.string() }),
  output: Approval.extend({
    content: z.unknown(),
    publishedContent: z.unknown().nullable(),
    publishedVersion: z.number().int().nullable(),
    diff: z.object({
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
    history: z.array(
      z.object({
        at: z.string(),
        by: z.object({ id: z.string(), name: z.string() }),
        status: z.enum(['approved', 'rejected']),
        note: z.string().nullable(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .select({ r: schema.approvalRequests, a: schema.artifacts })
      .from(schema.approvalRequests)
      .innerJoin(
        schema.artifacts,
        and(
          eq(schema.artifacts.workspaceId, schema.approvalRequests.workspaceId),
          eq(schema.artifacts.id, schema.approvalRequests.artifactId),
        ),
      )
      .where(and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), eq(schema.approvalRequests.id, input.approvalId)));
    if (!row) throw new AppError('not_found', `Approval request ${input.approvalId} does not exist in this workspace.`);
    const requester = (await resolveRequesters(ctx, [row.r])).get(row.r.id)!;
    const version = await loadVersion(ctx, row.r.artifactId, row.r.version);
    const published = row.a.publishedVersion ? await loadVersion(ctx, row.a.id, row.a.publishedVersion) : null;
    const directory = directoryOf(ctx);
    const decider = directory && row.r.decidedBy ? (await directory.users([row.r.decidedBy])).get(row.r.decidedBy) : undefined;
    const history =
      row.r.decidedBy && (row.r.status === 'approved' || row.r.status === 'rejected')
        ? [
            {
              at: (row.r.decidedAt ?? row.r.createdAt).toISOString(),
              by: { id: row.r.decidedBy, name: nameOf(decider, row.r.decidedBy) },
              status: row.r.status,
              note: row.r.decisionNote,
            },
          ]
        : [];
    return {
      ...approvalOut(ctx, row.r, row.a, requester, await bundlesOf(ctx, [row.r])),
      content: version.content,
      publishedContent: published?.content ?? null,
      publishedVersion: row.a.publishedVersion,
      diff: {
        from: row.a.publishedVersion,
        to: row.r.version,
        changes: diffJson(published?.content ?? {}, version.content),
      },
      history,
    };
  },
});

/**
 * Reads an approval request with its bundle's rows locked (in id order, so two deciders never
 * deadlock). A person's approval or veto and the hold runner both go through here, so whoever
 * locks first decides and the other sees the result (#263).
 */
async function lockApproval(ctx: CommandContext, approvalId: string) {
  const where = and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), eq(schema.approvalRequests.id, approvalId));
  const [first] = await ctx.tx.select({ bundleId: schema.approvalRequests.bundleId }).from(schema.approvalRequests).where(where);
  if (!first) return null;
  await ctx.tx
    .select({ id: schema.approvalRequests.id })
    .from(schema.approvalRequests)
    .where(
      and(
        eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId),
        first.bundleId ? eq(schema.approvalRequests.bundleId, first.bundleId) : eq(schema.approvalRequests.id, approvalId),
      ),
    )
    .orderBy(asc(schema.approvalRequests.id))
    .for('update');
  // Read again after the lock: a decision committed while we waited is visible now.
  const [r] = await ctx.tx.select().from(schema.approvalRequests).where(where);
  return r ?? null;
}

async function decide(ctx: CommandContext, approvalId: string) {
  const r = await lockApproval(ctx, approvalId);
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

/** The request itself, or every pending request of its bundle in publish order (#107). */
async function bundleMembers(ctx: CommandContext, r: ApprovalRow) {
  if (!r.bundleId) return [r];
  const rows = await ctx.tx
    .select({ r: schema.approvalRequests, content: schema.artifactVersions.content })
    .from(schema.approvalRequests)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.approvalRequests.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.approvalRequests.artifactId),
        eq(schema.artifactVersions.number, schema.approvalRequests.version),
      ),
    )
    .where(and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), eq(schema.approvalRequests.bundleId, r.bundleId)));
  const decided = rows.find((x) => x.r.status !== 'pending');
  if (decided) throw new AppError('conflict', `Part of this bundle (${decided.r.id}) was already ${decided.r.status}.`);
  return dependencyOrder(rows.map((x) => ({ id: x.r.artifactId, content: x.content, row: x.r }))).map((x) => x.row);
}

export const approve = defineCommand({
  name: 'approvals.approve',
  title: 'Approve and publish',
  description:
    'Approve a pending request and publish that version; for a bundle, every request in it, published in dependency order in one step. Only people can approve.',
  input: z.object({ approvalId: z.string(), note: z.string().max(1000).optional() }),
  output: z.object({
    status: z.literal('approved'),
    artifactId: z.string(),
    version: z.number().int(),
    published: z
      .array(z.object({ artifactId: z.string(), version: z.number().int() }))
      .describe('Everything this approval published, in order (more than one for a bundle)'),
  }),
  permission: 'artifacts:approve',
  effect: 'publish',
  humansOnly: true,
  target: (i) => i.approvalId,
  handler: async (input, ctx) => {
    const r = await decide(ctx, input.approvalId);
    await refuseIfAgentStopped(ctx, r);
    const members = await bundleMembers(ctx, r);
    for (const m of members) await publishVersion(ctx, m.artifactId, m.version);
    await ctx.tx
      .update(schema.approvalRequests)
      .set({ status: 'approved', decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: input.note ?? null })
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId),
          inArray(
            schema.approvalRequests.id,
            members.map((m) => m.id),
          ),
        ),
      );
    return {
      status: 'approved' as const,
      artifactId: r.artifactId,
      version: r.version,
      published: members.map((m) => ({ artifactId: m.artifactId, version: m.version })),
    };
  },
});

/**
 * A paused or revoked agent's pending changes wait (ADR-0016, #213): approving them would let the
 * agent act through a person while it is stopped. Rejecting stays possible.
 */
async function refuseIfAgentStopped(ctx: CommandContext, r: { requestedByType: string; requestedByClient: string | null }) {
  const agent = await requestingAgent(ctx, r);
  if (agent && agent.status !== 'active')
    throw new AppError(
      'conflict',
      `This change was requested by the agent “${agent.name}”, which is ${agent.status}. Resume the agent to approve it, or reject it.`,
    );
}

/** The agent behind an approval request's credential, if an agent requested it. */
/** The agent credential behind an approval's `requested_by_client`: `token:<id>`, `hosted:<agent id>` or an OAuth client id. */
export function agentCredentialOf(client: string): readonly ['api_token' | 'oauth_client' | 'hosted', string] {
  if (client.startsWith('token:')) return ['api_token', client.slice('token:'.length)] as const;
  if (client.startsWith('hosted:')) return ['hosted', client.slice('hosted:'.length)] as const;
  return ['oauth_client', client] as const;
}

async function requestingAgent(ctx: CommandContext, r: { requestedByType: string; requestedByClient: string | null }) {
  if (r.requestedByType !== 'agent' || !r.requestedByClient) return null;
  const [kind, credentialId] = agentCredentialOf(r.requestedByClient);
  const [agent] = await ctx.tx
    .select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status })
    .from(schema.agentCredentials)
    .innerJoin(
      schema.agents,
      and(eq(schema.agents.workspaceId, schema.agentCredentials.workspaceId), eq(schema.agents.id, schema.agentCredentials.agentId)),
    )
    .where(and(eq(schema.agentCredentials.kind, kind), eq(schema.agentCredentials.credentialId, credentialId)));
  return agent ?? null;
}

/**
 * The ledger row for a held change that ran (ADR-0016 §5.4): the hold row keeps the decision, this
 * one records what it actually did and how to reverse it, so `agents.undo` can offer the reversal.
 */
/** The note and ledger reason when a held change waits for the mandate's working hours. */
const WAIT_MARK = 'Waiting for the mandate’s working hours';

/**
 * A held change that did not run when its window ended (#282): a ledger entry the notifier
 * announces. Recorded as `artifacts.heldRecheck`, which the counters leave out (the hold itself
 * is counted), so a waiting change is not counted twice.
 */
async function recordHeldTransition(
  ctx: CommandContext,
  agentId: string,
  held: HeldAction | null,
  members: { artifactId: string }[],
  decision: 'ask' | 'hold',
  reason: string,
) {
  await recordAgentAction(
    ctx.tx,
    agentId,
    { name: HELD_RECHECK },
    {
      decision,
      actionClass: held?.actionClass ?? 'content.publish',
      reasons: [reason],
      impact: held?.impact ?? {},
      ...(held?.mandateId
        ? { mandate: { id: held.mandateId, version: held.mandateVersion ?? 0, holdWindow: 'PT2H', independentCheck: false } }
        : {}),
    },
    'internal',
    members.map((m) => m.artifactId).join(','),
    null,
    held?.intent ?? null,
  );
}

async function recordHeldExecution(
  ctx: CommandContext,
  agentId: string,
  held: HeldAction | null,
  published: { id: string; type: string; previousVersion: number | null; version: number }[],
) {
  await recordAgentAction(
    ctx.tx,
    agentId,
    { name: 'artifacts.requestPublish' },
    {
      decision: 'allow',
      actionClass: held?.actionClass ?? 'content.publish',
      reasons: ['Ran after its veto window ended without a veto.'],
      impact: held?.impact ?? {},
      ...(held?.mandateId
        ? { mandate: { id: held.mandateId, version: held.mandateVersion ?? 0, holdWindow: 'PT2H', independentCheck: false } }
        : {}),
    },
    'internal',
    published.map((p) => p.id).join(','),
    null,
    held?.intent ?? null,
    await publishUndoGroup(ctx, published),
  );
}

/**
 * Runs a held agent change whose veto window has ended (ADR-0016, #225). Re-checks at that moment
 * that the agent is active, the workspace lets agents act and its mandate still applies; if not,
 * the hold becomes an ordinary approval with the reason. Returns what happened.
 */
/** What the policy engine recorded when it held a change: its class, impact and mandate. */
export interface HeldAction {
  id: number;
  actionClass: ActionClass;
  impact: Impact;
  mandateId: string | null;
  mandateVersion: number | null;
  intent: string | null;
}

/** Whether a held change may run now: yes, not yet (e.g. outside working hours), or only with a person. */
/** The ledger command of a held change's recheck (#282); counters skip it. */
export const HELD_RECHECK = 'artifacts.heldRecheck';

export type HeldCheck = { run: true } | { wait: string } | { person: string };

/** How long a held change outside working hours waits before it is checked again. */
const HOLD_RECHECK_MS = 15 * 60_000;

/** The agent's ledger entry that held this artifact: the newest `hold` of a publish that names it. */
async function heldActionFor(ctx: CommandContext, agentId: string, artifactId: string): Promise<HeldAction | null> {
  const [held] = await ctx.tx
    .select({
      id: schema.agentActions.id,
      mandateId: schema.agentActions.mandateId,
      mandateVersion: schema.agentActions.mandateVersion,
      impact: schema.agentActions.impact,
      intent: schema.agentActions.intent,
      actionClass: schema.agentActions.actionClass,
    })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.workspaceId, ctx.principal.workspaceId),
        eq(schema.agentActions.agentId, agentId),
        eq(schema.agentActions.decision, 'hold'),
        sql`${schema.agentActions.command} IN ('artifacts.requestPublish', 'artifacts.requestPublishBundle', 'config.import')`,
        sql`${artifactId} = ANY(string_to_array(${schema.agentActions.target}, ','))`,
      ),
    )
    .orderBy(desc(schema.agentActions.id))
    .limit(1);
  return held ? { ...held, actionClass: held.actionClass as ActionClass, impact: (held.impact ?? {}) as Impact } : null;
}

export async function runHeldChange(
  ctx: CommandContext,
  approvalId: string,
  check: (agentId: string, held: HeldAction | null) => Promise<HeldCheck>,
): Promise<{ status: 'published' | 'needs_person' | 'not_due' | 'waiting'; reason?: string }> {
  // Locked: a veto or an early approval that commits first wins, and a second runner sees it (#263).
  const r = await lockApproval(ctx, approvalId);
  if (r?.status !== 'pending' || !r.holdUntil || r.holdUntil > new Date()) return { status: 'not_due' };
  const members = await bundleMembers(ctx, r);
  const agent = await requestingAgent(ctx, r);
  const held = agent ? await heldActionFor(ctx, agent.id, r.artifactId) : null;
  let problem: string | null = null;
  if (!agent) problem = 'the agent that requested it is no longer known';
  else if (agent.status !== 'active') problem = `the agent “${agent.name}” is ${agent.status}`;
  else {
    // The mandate, counters and guardrails are decided again now, not as they were when held (#262).
    const verdict = await check(agent.id, held);
    if ('person' in verdict) problem = verdict.person;
    else if ('wait' in verdict) {
      const firstWait = !r.note.includes(WAIT_MARK);
      const runsAt = new Date(Date.now() + HOLD_RECHECK_MS);
      await ctx.tx
        .update(schema.approvalRequests)
        .set({
          holdUntil: runsAt,
          ...(firstWait ? { note: sql`${schema.approvalRequests.note} || ${`\n\n${WAIT_MARK}: ${verdict.wait}`}` } : {}),
        })
        .where(
          and(
            eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId),
            inArray(
              schema.approvalRequests.id,
              members.map((m) => m.id),
            ),
          ),
        );
      // Announced once, when it first has to wait (#282); later rechecks only move the time.
      if (firstWait) await recordHeldTransition(ctx, agent.id, held, members, 'hold', `${WAIT_MARK}: ${verdict.wait}`);
      return { status: 'waiting', reason: verdict.wait };
    }
  }
  const ids = members.map((m) => m.id);
  const scope = and(eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId), inArray(schema.approvalRequests.id, ids));
  if (problem) {
    await ctx.tx
      .update(schema.approvalRequests)
      .set({
        holdUntil: null,
        note: sql`${schema.approvalRequests.note} || ${`\n\nNot run after its veto window: ${problem}. A person decides.`}`,
      })
      .where(scope);
    // The sponsor was told it would run; tell them it did not and that a person decides now (#282).
    if (agent)
      await recordHeldTransition(ctx, agent.id, held, members, 'ask', `Not run after its veto window: ${problem}. A person decides.`);
    return { status: 'needs_person', reason: problem };
  }
  const published: { id: string; type: string; previousVersion: number | null; version: number }[] = [];
  for (const m of members) {
    const artifact = await loadArtifact(ctx, m.artifactId);
    published.push({ id: artifact.id, type: artifact.type, previousVersion: artifact.publishedVersion, version: m.version });
    await publishVersion(ctx, m.artifactId, m.version);
  }
  // The hold row records the decision; this one row records what ran, for the counters and agents.undo.
  if (agent) await recordHeldExecution(ctx, agent.id, held, published);
  await ctx.tx
    .update(schema.approvalRequests)
    .set({
      status: 'approved',
      decidedBy: 'policy:hold',
      decidedAt: new Date(),
      decisionNote: 'Ran after its veto window ended without a veto.',
    })
    .where(scope);
  return { status: 'published' };
}

export const reject = defineCommand({
  name: 'approvals.reject',
  title: 'Reject a change',
  description:
    'Reject a pending request (for a bundle: every request in it). The versions stay in history as rejected; editing an artifact starts a new draft.',
  input: z.object({ approvalId: z.string(), note: z.string().min(1).max(1000).describe('Tell the author what to change') }),
  output: z.object({ status: z.literal('rejected'), artifactId: z.string(), version: z.number().int() }),
  permission: 'artifacts:approve',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.approvalId,
  handler: async (input, ctx) => {
    const r = await decide(ctx, input.approvalId);
    const members = await bundleMembers(ctx, r);
    for (const m of members) await setVersionState(ctx, m.artifactId, m.version, 'rejected');
    await ctx.tx
      .update(schema.approvalRequests)
      .set({ status: 'rejected', decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: input.note })
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ctx.principal.workspaceId),
          inArray(
            schema.approvalRequests.id,
            members.map((m) => m.id),
          ),
        ),
      );
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
  discardDraft,
  requestPublish,
  requestPublishBundle,
  listApprovals,
  getApproval,
  approve,
  reject,
] as const;

/** Content of the published version of a workspace's singleton artifact (tracking plan, purposes), if any. */
export async function publishedSingleton<
  T extends 'tracking_plan' | 'purposes' | 'delivery_policy' | 'conversion_map' | 'brand' | 'business_context',
>(tx: CommandContext['tx'], type: T): Promise<z.output<(typeof artifactTypes)[T]['content']> | null> {
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
