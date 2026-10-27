import { defineCommand } from '@agentic-marketing/commands';
import { AppError, hashValue } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { author, requestPublish, updateDraft, validateContent } from './commands';
import { type ArtifactType, artifactTypeEnum, artifactTypes } from './types';

// Config as code: a workspace's artifacts as one JSON bundle, to keep in git, review as diffs and
// promote from staging to production. Ids travel with the bundle (they are unique per
// workspace), so references between artifacts (a journey's template, a segment's segments) hold in
// the target workspace too. Importing goes through the same drafts and approval policy as any edit.

export const BUNDLE_FORMAT = 'agentic-marketing/artifacts@1' as const;

const BundleArtifact = z.object({
  id: z.string().regex(/^[a-z]{3}_[0-9a-f]{32}$/),
  type: artifactTypeEnum,
  name: z.string().min(1).max(120),
  version: z.number().int().positive().optional().describe('The version exported (informational)'),
  content: z.unknown(),
});
const Bundle = z.object({
  format: z.literal(BUNDLE_FORMAT),
  exportedAt: z.string().optional(),
  artifacts: z.array(BundleArtifact).max(2000),
});

export const exportConfig = defineCommand({
  name: 'config.export',
  title: 'Export artifacts as a bundle',
  description:
    'Every artifact of the workspace (published version, or the latest draft with includeDrafts) as one JSON bundle for git and config.import. Archived artifacts are left out.',
  input: z.object({
    types: z.array(artifactTypeEnum).optional().describe('Only these types (default: all)'),
    includeDrafts: z.boolean().default(false).describe('Export the latest version, also when it is not published'),
  }),
  output: Bundle.extend({ exportedAt: z.string() }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({ a: schema.artifacts, v: schema.artifactVersions })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        ),
      )
      .where(and(eq(schema.artifacts.archived, false), input.types ? inArray(schema.artifacts.type, input.types) : undefined));
    const artifacts = rows
      .filter(({ a, v }) => v.number === (input.includeDrafts ? a.latestVersion : a.publishedVersion))
      .sort((x, y) => x.a.type.localeCompare(y.a.type) || x.a.name.localeCompare(y.a.name) || x.a.id.localeCompare(y.a.id))
      .map(({ a, v }) => ({ id: a.id, type: a.type as ArtifactType, name: a.name, version: v.number, content: v.content }));
    return { format: BUNDLE_FORMAT, exportedAt: new Date().toISOString(), artifacts };
  },
});

/** Publishing order: what others refer to goes first. Within a type, later passes retry what had to wait. */
const ORDER: ArtifactType[] = [
  'purposes',
  'tracking_plan',
  'delivery_policy',
  'brand',
  'segment',
  'email_block',
  'email_template',
  'sms_template',
  'push_template',
  'prompt',
  'form',
  'conversion_map',
  'experience',
  'audience_sync',
  'broadcast',
  'journey',
  'note',
];

const Change = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  action: z.enum(['create', 'update', 'unchanged']),
  publish: z.enum(['published', 'in_review', 'failed', 'skipped']).optional(),
  problem: z.string().optional(),
});

export const importConfig = defineCommand({
  name: 'config.import',
  title: 'Import a bundle of artifacts',
  description:
    'Apply a bundle from config.export: creates missing artifacts (keeping their ids), puts changed content in a new draft, leaves equal ones alone. With publish, the drafts go through artifacts.requestPublish in dependency order, so the approval policy applies. Starts as a dry run; pass dryRun: false to apply. Nothing is deleted.',
  input: z.object({
    bundle: Bundle,
    dryRun: z.boolean().default(true),
    publish: z.boolean().default(false),
    note: z.string().min(1).max(1000).default('Imported from a config bundle'),
  }),
  output: z.object({ dryRun: z.boolean(), changes: z.array(Change) }),
  permission: 'artifacts:write',
  effect: 'write',
  handler: async (input, ctx) => {
    if (input.publish && !input.dryRun && !ctx.principal.permissions.has('artifacts:publish'))
      throw new AppError(
        'forbidden',
        'Publishing an import needs the artifacts:publish permission. Import without publish to create drafts.',
      );
    const ws = ctx.principal.workspaceId;
    const existing = await ctx.tx
      .select({ a: schema.artifacts, hash: schema.artifactVersions.contentHash })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
        ),
      );
    const byId = new Map(existing.map((e) => [e.a.id, e]));
    const singletons = new Map(existing.filter((e) => 'singleton' in artifactTypes[e.a.type as ArtifactType]).map((e) => [e.a.type, e]));
    const changes: z.infer<typeof Change>[] = [];
    const toPublish: { id: string; type: ArtifactType; change: z.infer<typeof Change> }[] = [];
    for (const item of input.bundle.artifacts) {
      const content = validateContent(item.type, item.content, 'draft');
      // A workspace has one of each singleton type, whatever its id.
      const current = byId.get(item.id) ?? ('singleton' in artifactTypes[item.type] ? singletons.get(item.type) : undefined);
      if (current && current.a.type !== item.type)
        throw new AppError('conflict', `${item.id} is a ${current.a.type} here, not a ${item.type}.`);
      const id = current?.a.id ?? item.id;
      const action = !current ? 'create' : current.hash !== hashValue(content) || current.a.name !== item.name ? 'update' : 'unchanged';
      const change: z.infer<typeof Change> = { id, type: item.type, name: item.name, action };
      changes.push(change);
      if (input.dryRun || action === 'unchanged') continue;
      if (action === 'create') {
        await ctx.tx.insert(schema.artifacts).values({ workspaceId: ws, id, type: item.type, name: item.name, latestVersion: 1 });
        await ctx.tx.insert(schema.artifactVersions).values({
          workspaceId: ws,
          artifactId: id,
          number: 1,
          state: 'draft',
          content,
          contentHash: hashValue(content),
          note: input.note,
          ...author(ctx),
        });
      } else await updateDraft.handler({ artifactId: id, content, name: item.name, note: input.note }, ctx);
      if (input.publish) toPublish.push({ id, type: item.type, change });
    }
    // Publish in dependency order; what fails for want of another artifact is retried in a later pass.
    let pending = toPublish.sort((x, y) => ORDER.indexOf(x.type) - ORDER.indexOf(y.type));
    for (let pass = 0; pending.length && pass < 5; pass++) {
      const failed: typeof pending = [];
      for (const p of pending)
        try {
          p.change.publish = (await requestPublish.handler({ artifactId: p.id, note: input.note }, ctx)).status;
          p.change.problem = undefined;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          p.change.publish = 'failed';
          p.change.problem = err.message;
          failed.push(p);
        }
      if (failed.length === pending.length) break;
      pending = failed;
    }
    for (const c of changes) if (input.publish && !input.dryRun && c.action === 'unchanged') c.publish = 'skipped';
    return { dryRun: input.dryRun, changes };
  },
});

export const configCommands = [exportConfig, importConfig] as const;
