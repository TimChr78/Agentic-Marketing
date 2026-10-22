import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { schema, type WarehouseDataset } from '@agentic-marketing/db';
import { sealJson } from '@agentic-marketing/secrets';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DATASETS } from './datasets';
import { postgresConfig, postgresSecrets, s3Config, s3Secrets } from './destinations';

const ExportId = z.string().regex(/^whx_[0-9a-f]{32}$/);
const Dataset = z.enum(Object.keys(DATASETS) as [WarehouseDataset, ...WarehouseDataset[]]);
const Kind = z.enum(['postgres', 's3']);

const Export = z.object({
  id: z.string(),
  name: z.string(),
  kind: Kind,
  config: z.record(z.string(), z.unknown()),
  datasets: z.array(Dataset),
  everyMinutes: z.number().int(),
  enabled: z.boolean(),
  hasCredentials: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.enum(['ok', 'failed']).nullable(),
  lastError: z.string().nullable(),
  lastCounts: z.record(z.string(), z.number()),
  exportedUntil: z.record(z.string(), z.string()).describe('Per dataset, the time up to which rows have been exported'),
});

const out = (r: typeof schema.warehouseExports.$inferSelect): z.infer<typeof Export> => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  config: r.config,
  datasets: r.datasets,
  everyMinutes: r.everyMinutes,
  enabled: r.enabled,
  hasCredentials: !!r.secrets,
  lastRunAt: r.lastRunAt?.toISOString() ?? null,
  lastStatus: r.lastStatus ?? null,
  lastError: r.lastError ?? null,
  lastCounts: r.lastCounts,
  exportedUntil: r.cursors,
});

function checkSettings(kind: 'postgres' | 's3', config: unknown, secrets: unknown) {
  const [c, s] = kind === 'postgres' ? [postgresConfig, postgresSecrets] : [s3Config, s3Secrets];
  const config_ = (c as z.ZodType).safeParse(config ?? {});
  if (!config_.success) throw new AppError('invalid_input', `Settings for ${kind} are not valid.`, z.treeifyError(config_.error));
  if (secrets === undefined) return { config: config_.data as Record<string, unknown>, secrets: undefined };
  const secrets_ = (s as z.ZodType).safeParse(secrets);
  if (!secrets_.success) throw new AppError('invalid_input', `Credentials for ${kind} are not valid.`, z.treeifyError(secrets_.error));
  return { config: config_.data as Record<string, unknown>, secrets: secrets_.data as Record<string, unknown> };
}

async function load(ctx: Parameters<(typeof listExports)['handler']>[1], id: string) {
  const [r] = await ctx.tx.select().from(schema.warehouseExports).where(eq(schema.warehouseExports.id, id));
  if (!r) throw new AppError('not_found', `No warehouse export ${id}. List them with warehouse.list.`);
  return r;
}

export const listExports = defineCommand({
  name: 'warehouse.list',
  title: 'List warehouse exports',
  description:
    'Warehouse destinations (Postgres, S3-compatible storage), what they receive, and how the last run went. Credentials are never returned.',
  input: z.object({}),
  output: z.object({ exports: z.array(Export) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_i, ctx) => ({
    exports: (await ctx.tx.select().from(schema.warehouseExports).orderBy(schema.warehouseExports.createdAt)).map(out),
  }),
});

export const createExport = defineCommand({
  name: 'warehouse.create',
  title: 'Add a warehouse export',
  description:
    'Export pseudonymous data on a schedule: profiles (non-personal traits), user and anonymous ids, consent, segment memberships, events and message events, plus erasures. `postgres` upserts into am_* tables of a schema (secrets: { url }); `s3` writes gzipped NDJSON files that BigQuery, Snowflake and others load (config: bucket, region, endpoint, prefix; secrets: accessKeyId, secretAccessKey).',
  input: z.object({
    name: z.string().min(1).max(120),
    kind: Kind,
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()),
    datasets: z
      .array(Dataset)
      .min(1)
      .default(Object.keys(DATASETS) as WarehouseDataset[]),
    everyMinutes: z.number().int().min(5).max(10080).default(60),
  }),
  output: Export,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  handler: async (input, ctx) => {
    const { config, secrets } = checkSettings(input.kind, input.config, input.secrets);
    const sealed = await sealJson(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, secrets);
    const [row] = await ctx.tx
      .insert(schema.warehouseExports)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('whx'),
        name: input.name,
        kind: input.kind,
        config,
        secrets: sealed.blob,
        secretsKeyId: sealed.keyId,
        datasets: [...new Set(input.datasets)],
        everyMinutes: input.everyMinutes,
        runRequested: true,
      })
      .returning();
    return out(row);
  },
});

export const updateExport = defineCommand({
  name: 'warehouse.update',
  title: 'Change a warehouse export',
  description: 'Change settings, datasets, the interval or credentials (replaced as a whole when given), or pause it.',
  input: z.object({
    id: ExportId,
    name: z.string().min(1).max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.unknown()).optional(),
    datasets: z.array(Dataset).min(1).optional(),
    everyMinutes: z.number().int().min(5).max(10080).optional(),
    enabled: z.boolean().optional(),
  }),
  output: Export,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['secrets'],
  target: (i) => i.id,
  handler: async ({ id, config, secrets, datasets, ...rest }, ctx) => {
    const cur = await load(ctx, id);
    const checked = checkSettings(cur.kind, config ?? cur.config, secrets);
    const sealed = checked.secrets ? await sealJson(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, checked.secrets) : null;
    const [row] = await ctx.tx
      .update(schema.warehouseExports)
      .set({
        ...rest,
        config: checked.config,
        ...(datasets ? { datasets: [...new Set(datasets)] } : {}),
        ...(sealed ? { secrets: sealed.blob, secretsKeyId: sealed.keyId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.warehouseExports.id, id))
      .returning();
    return out(row);
  },
});

export const runExportNow = defineCommand({
  name: 'warehouse.run',
  title: 'Run a warehouse export now',
  description:
    'Run the export at the next scheduler tick (within about 30 seconds) instead of waiting for its interval. Check the outcome with warehouse.list.',
  input: z.object({ id: ExportId }),
  output: z.object({ requested: z.boolean() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    await load(ctx, input.id);
    await ctx.tx.update(schema.warehouseExports).set({ runRequested: true }).where(eq(schema.warehouseExports.id, input.id));
    return { requested: true };
  },
});

export const deleteExport = defineCommand({
  name: 'warehouse.delete',
  title: 'Remove a warehouse export',
  description: 'Stop exporting and forget the destination and its credentials. Data already exported stays where it is.',
  input: z.object({ id: ExportId }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    await load(ctx, input.id);
    await ctx.tx.delete(schema.warehouseExports).where(eq(schema.warehouseExports.id, input.id));
    return { deleted: true };
  },
});

export const warehouseCommands = [listExports, createExport, updateExport, runExportNow, deleteExport] as const;
