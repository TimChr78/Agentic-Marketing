import { createHash } from 'node:crypto';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ASSET_CONTENT_TYPES,
  type AssetContentType,
  assetKind,
  extensionlessName,
  imageSize,
  megabytes,
  renditionFileName,
  sanitiseFileName,
  sniffContentType,
  svgFileName,
} from './media';
import { rasteriseSvg } from './raster';
import { sanitiseSvg } from './svg';

declare module '@agentic-marketing/commands' {
  interface Services {
    assets: { publicUrl: string; maxBytes: number };
  }
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
const AssetId = z.string().regex(/^ast_[0-9a-f]{32}$/, 'Not an asset id. Use the id from assets.list.');

const Rendition = z.object({
  contentType: z.string(),
  byteSize: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  /** The PNG URL e-mail may use; the asset's own url stays the SVG for hosted pages. */
  url: z.string(),
});

const Asset = z.object({
  id: z.string(),
  name: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  kind: z.enum(['image', 'file']),
  byteSize: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  altText: z.string(),
  url: z.string(),
  rendition: Rendition.nullable(),
  /** Parts removed from an SVG upload; empty for raster images and PDFs. */
  sanitized: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  usageCount: z.number().int(),
});

const AssetUsage = z.object({
  artifactId: z.string(),
  artifactName: z.string(),
  artifactType: z.string(),
  versions: z.array(z.enum(['latest', 'published'])),
});

type AssetRow = typeof schema.assets.$inferSelect;

type UsageRow = {
  asset_id: string;
  artifact_id: string;
  artifact_name: string;
  artifact_type: string;
  latest: boolean;
  published: boolean;
};

/**
 * Which latest or published artifact versions mention each asset, in one query over the version
 * JSON (no per-asset lookup). Assets are referenced by their id inside e-mail HTML, page content
 * and the like, so a text match is deliberate and cheaper than walking every content schema.
 */
async function usageRows(tx: Tx, assetIds: string[]): Promise<UsageRow[]> {
  if (!assetIds.length) return [];
  const { rows } = await tx.execute(sql`
    SELECT a.id AS asset_id, art.id AS artifact_id, art.name AS artifact_name, art.type AS artifact_type,
           (v.number = art.latest_version) AS latest,
           (v.number = art.published_version) AS published
    FROM artifact_versions v
    JOIN artifacts art ON art.workspace_id = v.workspace_id AND art.id = v.artifact_id
    JOIN assets a ON a.workspace_id = v.workspace_id
    WHERE a.id = ANY(${sql.param(assetIds)}::text[])
      AND (v.number = art.latest_version OR v.number = art.published_version)
      AND strpos(v.content::text, a.id) > 0
    ORDER BY art.name, art.id
  `);
  return rows as UsageRow[];
}

type Usage = z.output<typeof AssetUsage>;

function usageByAsset(rows: UsageRow[]): Map<string, Map<string, Usage>> {
  const byAsset = new Map<string, Map<string, Usage>>();
  for (const row of rows) {
    const byArtifact = byAsset.get(row.asset_id) ?? new Map<string, Usage>();
    const entry = byArtifact.get(row.artifact_id) ?? {
      artifactId: row.artifact_id,
      artifactName: row.artifact_name,
      artifactType: row.artifact_type,
      versions: [],
    };
    if (row.latest && !entry.versions.includes('latest')) entry.versions.push('latest');
    if (row.published && !entry.versions.includes('published')) entry.versions.push('published');
    byArtifact.set(row.artifact_id, entry);
    byAsset.set(row.asset_id, byArtifact);
  }
  return byAsset;
}

function usageCounts(rows: UsageRow[]): Map<string, number> {
  return new Map([...usageByAsset(rows)].map(([assetId, byArtifact]) => [assetId, byArtifact.size]));
}

type RenditionRow = Pick<typeof schema.assetRenditions.$inferSelect, 'assetId' | 'contentType' | 'byteSize' | 'width' | 'height'>;

function toAsset(row: AssetRow, publicUrl: string, usageCount: number, rendition?: RenditionRow | null, sanitized: string[] = []) {
  return {
    id: row.id,
    name: row.name,
    fileName: row.fileName,
    contentType: row.contentType,
    kind: assetKind(row.contentType as AssetContentType),
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    altText: row.altText,
    url: `${publicUrl}/a/${row.id}/${row.fileName}`,
    rendition: rendition
      ? {
          contentType: rendition.contentType,
          byteSize: rendition.byteSize,
          width: rendition.width,
          height: rendition.height,
          url: `${publicUrl}/a/${row.id}/${renditionFileName(row.fileName)}`,
        }
      : null,
    sanitized,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    usageCount,
  };
}

/** Rendition metadata without the PNG bytes, for list responses. */
async function renditionsFor(tx: Tx, assetIds: string[]): Promise<Map<string, RenditionRow>> {
  if (!assetIds.length) return new Map();
  const rows = await tx
    .select({
      assetId: schema.assetRenditions.assetId,
      contentType: schema.assetRenditions.contentType,
      byteSize: schema.assetRenditions.byteSize,
      width: schema.assetRenditions.width,
      height: schema.assetRenditions.height,
    })
    .from(schema.assetRenditions)
    .where(inArray(schema.assetRenditions.assetId, assetIds));
  return new Map(rows.map((row) => [row.assetId, row]));
}

async function loadAsset(ctx: CommandContext, id: string): Promise<AssetRow> {
  const [row] = await ctx.tx
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.workspaceId, ctx.principal.workspaceId), eq(schema.assets.id, id), isNull(schema.assets.deletedAt)));
  if (!row) throw new AppError('not_found', `Asset ${id} does not exist or was deleted.`);
  return row;
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  // Accept the URL-safe alphabet and ignore the line breaks some encoders add.
  const compact = value.replace(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new AppError('invalid_input', 'dataBase64 is not valid base64. Encode the file bytes with standard base64.');
  }
  const data = Buffer.from(compact.padEnd(Math.ceil(compact.length / 4) * 4, '='), 'base64');
  if (!data.length) throw new AppError('invalid_input', 'The file is empty. Upload a PNG, JPEG, GIF, WebP, SVG or PDF with content.');
  if (data.length > maxBytes) {
    throw new AppError(
      'invalid_input',
      `The file is ${megabytes(data.length)} MB, over the ${megabytes(maxBytes)} MB limit. Upload a smaller file or raise ASSET_MAX_BYTES.`,
    );
  }
  return data;
}

function checkedBytes(data: Buffer, declared: AssetContentType): Buffer {
  const detected = sniffContentType(data);
  if (!detected) {
    if (declared === 'image/svg+xml') {
      throw new AppError(
        'invalid_input',
        'The file is not an SVG: an SVG is XML whose root element is <svg>. Check the file and upload it again.',
      );
    }
    throw new AppError('invalid_input', 'The file is not a PNG, JPEG, GIF, WebP, SVG or PDF. Check the file and upload it again.');
  }
  if (detected !== declared) {
    throw new AppError(
      'invalid_input',
      `The file is a ${detected}, not the declared ${declared}. Set contentType to ${detected} or upload the right file.`,
    );
  }
  return data;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime()) && /^ast_[0-9a-f]{32}$/.test(parsed[1])) return { createdAt, id: parsed[1] };
    }
  } catch {
    // Fall through to the same clear error.
  }
  throw new AppError('invalid_input', 'The cursor is not valid. Leave it out to start from the newest assets.');
}

export const uploadAsset = defineCommand({
  name: 'assets.upload',
  title: 'Upload an asset',
  description:
    'Upload a PNG, JPEG, GIF, WebP or SVG image, or a PDF, for e-mails and hosted pages. The declared content type is checked against the bytes; images record their pixel size. An SVG is sanitised (unsafe elements and attributes are removed and listed in `sanitized`) and a PNG rendition is stored for e-mail. Returns a stable public URL.',
  input: z.object({
    name: z.string().trim().min(1).max(120).optional().describe('Display name; defaults to the file name without its extension'),
    fileName: z.string().trim().min(1).max(200).describe('Original file name, e.g. "welcome.png"; sanitised for the URL'),
    contentType: z.enum(
      ASSET_CONTENT_TYPES,
      'The content type is not supported. Use image/png, image/jpeg, image/gif, image/webp, image/svg+xml or application/pdf.',
    ),
    dataBase64: z.string().min(1).describe('The file bytes as standard base64 (without a data: prefix)'),
    altText: z.string().max(500).optional().describe('Alternative text for images, read by screen readers'),
  }),
  output: Asset,
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'content.publish',
  sensitive: ['dataBase64'],
  target: (input) => input.fileName,
  handler: async (input, ctx) => {
    const { publicUrl, maxBytes } = ctx.services.assets;
    let data = checkedBytes(decodeBase64(input.dataBase64, maxBytes), input.contentType);
    let sanitized: string[] = [];
    let rendition: ReturnType<typeof rasteriseSvg> | null = null;
    if (input.contentType === 'image/svg+xml') {
      const clean = sanitiseSvg(data);
      data = Buffer.from(clean.svg, 'utf8');
      sanitized = clean.sanitized;
      rendition = rasteriseSvg(clean.svg, clean.size);
    }
    const fileName =
      input.contentType === 'image/svg+xml' ? svgFileName(sanitiseFileName(input.fileName)) : sanitiseFileName(input.fileName);
    const size = imageSize(data, input.contentType);
    const id = newId('ast');
    const now = new Date();
    const row: AssetRow = {
      workspaceId: ctx.principal.workspaceId,
      id,
      name: (input.name ?? extensionlessName(fileName)).slice(0, 120),
      fileName,
      contentType: input.contentType,
      byteSize: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      width: size?.width ?? null,
      height: size?.height ?? null,
      altText: input.altText ?? '',
      createdBy: ctx.principal.userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await ctx.tx.insert(schema.assets).values(row);
    // Object-store driver: write here, and keep only a key in assets instead of the blob row.
    await ctx.tx.insert(schema.assetBlobs).values({ workspaceId: row.workspaceId, assetId: id, data });
    if (rendition) {
      await ctx.tx.insert(schema.assetRenditions).values({
        workspaceId: row.workspaceId,
        assetId: id,
        kind: 'png',
        contentType: 'image/png',
        byteSize: rendition.data.length,
        sha256: createHash('sha256').update(rendition.data).digest('hex'),
        width: rendition.width,
        height: rendition.height,
        data: rendition.data,
      });
    }
    return toAsset(
      row,
      publicUrl,
      0,
      rendition
        ? {
            assetId: id,
            contentType: 'image/png',
            byteSize: rendition.data.length,
            width: rendition.width,
            height: rendition.height,
          }
        : null,
      sanitized,
    );
  },
});

export const listAssets = defineCommand({
  name: 'assets.list',
  title: 'List assets',
  description:
    'Assets newest first, optionally filtered by a case-insensitive search across name, file name and alt text, and by kind. Page with the returned cursor.',
  input: z.object({
    query: z.string().max(200).optional().describe('Match name, file name or alt text, case-insensitive'),
    kind: z.enum(['image', 'file']).optional().describe('image: PNG, JPEG, GIF, WebP or SVG; file: PDF'),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(500).optional().describe('nextCursor from the previous page'),
  }),
  output: z.object({ assets: z.array(Asset), nextCursor: z.string().nullable() }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const { publicUrl } = ctx.services.assets;
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const query = input.query?.trim();
    const pattern = query ? `%${escapeLike(query)}%` : null;
    const rows = await ctx.tx
      .select()
      .from(schema.assets)
      .where(
        and(
          isNull(schema.assets.deletedAt),
          input.kind ? inArray(schema.assets.contentType, input.kind === 'image' ? IMAGE_TYPES : ['application/pdf']) : undefined,
          pattern
            ? or(ilike(schema.assets.name, pattern), ilike(schema.assets.fileName, pattern), ilike(schema.assets.altText, pattern))
            : undefined,
          cursor ? sql`(${schema.assets.createdAt}, ${schema.assets.id}) < (${cursor.createdAt}, ${cursor.id})` : undefined,
        ),
      )
      .orderBy(desc(schema.assets.createdAt), desc(schema.assets.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const counts = usageCounts(
      await usageRows(
        ctx.tx,
        page.map((r) => r.id),
      ),
    );
    const renditions = await renditionsFor(
      ctx.tx,
      page.map((r) => r.id),
    );
    const last = page.at(-1);
    return {
      assets: page.map((row) => toAsset(row, publicUrl, counts.get(row.id) ?? 0, renditions.get(row.id))),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString('base64url')
          : null,
    };
  },
});

export const getAsset = defineCommand({
  name: 'assets.get',
  title: 'Get an asset',
  description: 'One asset with its public URL and the latest or published artifacts that reference it.',
  input: z.object({ id: AssetId }),
  output: Asset.extend({ usage: z.array(AssetUsage) }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const { publicUrl } = ctx.services.assets;
    const row = await loadAsset(ctx, input.id);
    const usage = usageByAsset(await usageRows(ctx.tx, [row.id])).get(row.id);
    const entries = usage ? [...usage.values()] : [];
    const renditions = await renditionsFor(ctx.tx, [row.id]);
    return { ...toAsset(row, publicUrl, entries.length, renditions.get(row.id)), usage: entries };
  },
});

export const updateAsset = defineCommand({
  name: 'assets.update',
  title: 'Rename an asset',
  description: 'Change an asset’s display name or alternative text. The file bytes and public URL cannot be changed.',
  input: z
    .object({
      id: AssetId,
      name: z.string().trim().min(1).max(120).optional(),
      altText: z.string().max(500).optional(),
    })
    .refine((input) => input.name !== undefined || input.altText !== undefined, {
      message: 'Provide a name or altText to change.',
      path: ['name'],
    }),
  output: Asset,
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'content.publish',
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const { publicUrl } = ctx.services.assets;
    const [row] = await ctx.tx
      .update(schema.assets)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.assets.workspaceId, ctx.principal.workspaceId), eq(schema.assets.id, input.id), isNull(schema.assets.deletedAt)))
      .returning();
    if (!row) throw new AppError('not_found', `Asset ${input.id} does not exist or was deleted.`);
    const count = usageCounts(await usageRows(ctx.tx, [row.id])).get(row.id) ?? 0;
    const renditions = await renditionsFor(ctx.tx, [row.id]);
    return toAsset(row, publicUrl, count, renditions.get(row.id));
  },
});

export const deleteAsset = defineCommand({
  name: 'assets.delete',
  title: 'Delete an asset',
  description:
    'Delete an asset. Deleting is refused while a latest or published artifact still references it, unless force is true (people only). The public URL then answers 410 Gone.',
  input: z.object({
    id: AssetId,
    force: z.boolean().default(false).describe('Delete although artifacts still use it; only a person may force'),
  }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'artifacts:write',
  effect: 'destructive',
  actionClass: 'destructive',
  target: (input) => input.id,
  handler: async (input, ctx) => {
    if (input.force && ctx.principal.type === 'agent') {
      throw new AppError('forbidden', 'Agents cannot force-delete an asset. Ask a person to remove it from its artifacts first.');
    }
    const row = await loadAsset(ctx, input.id);
    const usage = [
      ...(usageByAsset(await usageRows(ctx.tx, [row.id]))
        .get(row.id)
        ?.values() ?? []),
    ];
    if (usage.length && !input.force) {
      const listed = usage
        .slice(0, 5)
        .map((u) => `${u.artifactName} (${u.artifactType})`)
        .join(', ');
      const more = usage.length > 5 ? ` and ${usage.length - 5} more` : '';
      throw new AppError(
        'conflict',
        `Used in ${usage.length} artifact${usage.length === 1 ? '' : 's'}: ${listed}${more}. Remove it there first, or delete with force: true.`,
        { usage },
      );
    }
    const now = new Date();
    await ctx.tx
      .update(schema.assets)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(eq(schema.assets.workspaceId, ctx.principal.workspaceId), eq(schema.assets.id, input.id), isNull(schema.assets.deletedAt)),
      );
    // The metadata row stays for the audit trail and the 410 answer; the bytes go now.
    await ctx.tx
      .delete(schema.assetBlobs)
      .where(and(eq(schema.assetBlobs.workspaceId, ctx.principal.workspaceId), eq(schema.assetBlobs.assetId, input.id)));
    await ctx.tx
      .delete(schema.assetRenditions)
      .where(and(eq(schema.assetRenditions.workspaceId, ctx.principal.workspaceId), eq(schema.assetRenditions.assetId, input.id)));
    return { deleted: true };
  },
});

export const assetCommands = [uploadAsset, listAssets, getAsset, updateAsset, deleteAsset] as const;
