import {
  artifactTypes,
  contentValidators,
  type EmailBlock,
  type EmailBlockParam,
  type EmailTemplate,
  referenceExtractors,
} from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { blockIdsIn, usesBlockTag, wrapMjmlFragment } from './blockTags';
import {
  type BlockDefinition,
  type BlockResolver,
  compileMjml,
  type RenderVars,
  renderBlockFragment,
  renderBlockFragmentSync,
} from './render';

// Reusable e-mail blocks (#73). A block is a versioned MJML fragment; a template inlines the
// block's published version with {% block 'blk_…', key: value %}. Rendering resolves the block
// from the database at send time, so a later block version never changes an e-mail already sent.

const BlockId = z.string().regex(/^blk_[0-9a-f]{32}$/, 'A block id (blk_…)');

/** A value for each parameter: its default, else something valid for its type. */
export function sampleBlockParams(block: Pick<EmailBlock, 'params'>): Record<string, string> {
  const sample: Record<EmailBlockParam['type'], string> = {
    text: 'Sample text',
    url: 'https://example.com',
    image: 'https://example.com/image.png',
    color: '#111827',
    html: '<p>Sample HTML</p>',
  };
  return Object.fromEntries(block.params.map((p) => [p.key, p.default ?? sample[p.type]]));
}

/** Checks that run on every save, so a broken fragment or a nested block is caught immediately. */
export function validateBlockContent(block: EmailBlock): string[] {
  const problems: string[] = [];
  if (usesBlockTag(block.mjml)) problems.push('A block cannot use another block in v1; keep the shared part in the template');
  if (/<\/?mjml[\s>]/i.test(block.mjml)) problems.push('A block is an MJML fragment, not a whole <mjml> document');
  if (problems.length) return problems;
  let mjml: string;
  try {
    mjml = renderBlockFragmentSync({ id: 'block', mjml: block.mjml, params: block.params }, sampleBlockParams(block));
  } catch (e) {
    return [`Liquid error: ${(e as Error).message.split('\n')[0]}`];
  }
  try {
    const out = compileMjml(wrapMjmlFragment(mjml));
    problems.push(...out.warnings.slice(0, 10));
  } catch (e) {
    problems.push(`mjml: ${(e as Error).message.split('\n')[0]}`);
  }
  return problems;
}

contentValidators.set('email_block', (content) => validateBlockContent(content as EmailBlock));

/**
 * A template can use blocks; it can be published only with the published versions of those blocks.
 * templates.ts registers the one email_template publish validator and calls this first (a second
 * publishValidators.set would replace the first).
 */
export async function blockPublishProblems(content: unknown, tx: Tx): Promise<string[]> {
  const ids = blockIdsIn((content as EmailTemplate).mjml ?? '');
  if (!ids.length) return [];
  const found = await tx
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(inArray(schema.artifacts.id, ids), eq(schema.artifacts.type, 'email_block'), isNotNull(schema.artifacts.publishedVersion)));
  const published = new Set(found.map((f) => f.id));
  return ids.filter((id) => !published.has(id)).map((id) => `${id} is not a published e-mail block`);
}

/** artifacts.get lists the block ids a template uses, so a reviewer sees the references. */
referenceExtractors.set('email_template', (content) => blockIdsIn((content as EmailTemplate).mjml ?? ''));

/** Loads published blocks for the renderer; unpublished or missing blocks come back as null. */
export function blockResolver(tx: Tx): BlockResolver {
  return async (id) => {
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
      .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.type, 'email_block')));
    if (!row) return null;
    const block = artifactTypes.email_block.content.parse(row.content) as EmailBlock;
    return { id, mjml: block.mjml, params: block.params } satisfies BlockDefinition;
  };
}

export const previewBlock = defineCommand({
  name: 'blocks.preview',
  title: 'Preview an e-mail block',
  description:
    'Render a block version (default: the latest) to HTML with its default parameters, or with values you pass. Nothing is sent.',
  input: z.object({
    artifactId: BlockId,
    version: z.number().int().min(1).optional(),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Parameter values, over the block defaults'),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Normal template variables the block uses, e.g. {"profile":{"firstName":"Ada"}}'),
  }),
  output: z.object({
    version: z.number().int(),
    html: z.string(),
    warnings: z.array(z.string()),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [v] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.artifactId, input.artifactId),
          input.version ? eq(schema.artifactVersions.number, input.version) : undefined,
        ),
      )
      .orderBy(desc(schema.artifactVersions.number))
      .limit(1);
    if (!v) throw new AppError('not_found', `No block ${input.artifactId}${input.version ? ` version ${input.version}` : ''}.`);
    const block = artifactTypes.email_block.content.parse(v.content) as EmailBlock;
    const params = { ...sampleBlockParams(block), ...(input.params ?? {}) };
    try {
      const mjml = await renderBlockFragment(
        { id: input.artifactId, mjml: block.mjml, params: block.params },
        params,
        (input.data ?? {}) as RenderVars,
      );
      const out = compileMjml(wrapMjmlFragment(mjml));
      return { version: v.number, html: out.html, warnings: out.warnings };
    } catch (e) {
      throw new AppError('invalid_input', `The block could not be rendered: ${(e as Error).message.split('\n')[0]}`);
    }
  },
});

interface BlockUsageRow {
  artifactId: string;
  name: string;
  latestVersion: number;
  publishedVersion: number | null;
  usesLatest: boolean;
  usesPublished: boolean;
}

export const blockUsage = defineCommand({
  name: 'blocks.usage',
  title: 'Where a block is used',
  description:
    'Templates whose latest or published version uses this block, so a reviewer can see what a change affects. Scans the template content for {% block … %}.',
  input: z.object({ artifactId: BlockId }),
  output: z.object({
    templates: z.array(
      z.object({
        artifactId: z.string(),
        name: z.string(),
        latestVersion: z.number().int(),
        publishedVersion: z.number().int().nullable(),
        usesLatest: z.boolean(),
        usesPublished: z.boolean(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const rows = await ctx.tx
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
          or(
            eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
            eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
          ),
        ),
      )
      .where(eq(schema.artifacts.type, 'email_template'));
    const byId = new Map<string, BlockUsageRow>();
    for (const row of rows) {
      const uses = blockIdsIn((row.content as EmailTemplate).mjml ?? '').includes(input.artifactId);
      const current = byId.get(row.id) ?? {
        artifactId: row.id,
        name: row.name,
        latestVersion: row.latestVersion,
        publishedVersion: row.publishedVersion,
        usesLatest: false,
        usesPublished: false,
      };
      if (uses) {
        if (row.number === row.latestVersion) current.usesLatest = true;
        if (row.publishedVersion !== null && row.number === row.publishedVersion) current.usesPublished = true;
      }
      byId.set(row.id, current);
    }
    return {
      templates: [...byId.values()].filter((t) => t.usesLatest || t.usesPublished).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

export const blockCommands = [previewBlock, blockUsage] as const;
