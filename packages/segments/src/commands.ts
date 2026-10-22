import { artifactTypes, segmentCondition } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { contextFor, publishedSegments, publishInSlices, refreshSegment } from './membership';
import { materialize } from './sql';

const SegmentId = z.string().regex(/^seg_[0-9a-f]{32}$/);

export const previewSegment = defineCommand({
  name: 'segments.preview',
  title: 'Preview a segment',
  description:
    'Count who matches a segment definition right now, with a sample. Pass a saved segment (any version) or a condition to try out.',
  input: z.object({
    artifactId: SegmentId.optional(),
    version: z.number().int().min(1).optional(),
    condition: segmentCondition.optional().describe('A condition to evaluate instead of a saved segment'),
  }),
  output: z.object({ count: z.number().int(), sample: z.array(z.string()), tookMs: z.number().int() }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    let condition = input.condition;
    if (!condition) {
      if (!input.artifactId) throw new AppError('invalid_input', 'Pass a segment artifactId or a condition.');
      const [v] = await ctx.tx
        .select({ content: schema.artifactVersions.content })
        .from(schema.artifactVersions)
        .where(
          and(
            eq(schema.artifactVersions.artifactId, input.artifactId),
            input.version ? eq(schema.artifactVersions.number, input.version) : undefined,
          ),
        )
        .orderBy(desc(schema.artifactVersions.number))
        .limit(1);
      if (!v) throw new AppError('not_found', `No segment ${input.artifactId}.`);
      condition = artifactTypes.segment.content.parse(v.content).condition;
    }
    const started = Date.now();
    // The previewed version stands in for its segment, so references back to it are checked too.
    let segments = await publishedSegments(ctx.tx);
    if (input.artifactId)
      segments = [
        ...segments.filter((s) => s.id !== input.artifactId),
        { id: input.artifactId, name: '', version: 0, definition: { description: '', condition } },
      ];
    const evalCtx = contextFor(
      ctx.tx,
      ctx.principal.workspaceId,
      ctx.services.events,
      segments,
      input.artifactId ? { _stack: [input.artifactId] } : {},
    );
    const members = await materialize(condition, evalCtx);
    const sample = await ctx.tx.execute<{ profile_id: string }>(sql.raw(`SELECT profile_id FROM ${members.table} LIMIT 20`));
    return { count: members.size, sample: sample.rows.map((r) => r.profile_id), tookMs: Date.now() - started };
  },
});

export const segmentMembers = defineCommand({
  name: 'segments.members',
  title: 'Members of a segment',
  description: 'Current members of a published segment, oldest membership first. Page with `after` (a profile id).',
  input: z.object({ artifactId: SegmentId, limit: z.number().int().min(1).max(1000).default(100), after: z.string().optional() }),
  output: z.object({ members: z.array(z.object({ profileId: z.string(), since: z.string() })), total: z.number().int().nullable() }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.segmentMemberships)
      .where(
        and(
          eq(schema.segmentMemberships.segmentId, input.artifactId),
          input.after ? gt(schema.segmentMemberships.profileId, input.after) : undefined,
        ),
      )
      .orderBy(schema.segmentMemberships.profileId)
      .limit(input.limit);
    const [run] = await ctx.tx.select().from(schema.segmentRuns).where(eq(schema.segmentRuns.segmentId, input.artifactId));
    return { members: rows.map((r) => ({ profileId: r.profileId, since: r.since.toISOString() })), total: run?.members ?? null };
  },
});

export const refreshSegmentCommand = defineCommand({
  name: 'segments.refresh',
  title: 'Recompute a segment now',
  description:
    'Recompute the published segment for everyone and emit "Segment Entered"/"Segment Exited" events for the changes (journeys may react). Segments are also recomputed on a schedule.',
  input: z.object({ artifactId: SegmentId }),
  output: z.object({ members: z.number().int(), entered: z.number().int(), exited: z.number().int() }),
  permission: 'artifacts:publish',
  effect: 'write',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const all = await publishedSegments(ctx.tx);
    const seg = all.find((s) => s.id === input.artifactId);
    if (!seg) throw new AppError('not_found', `Segment ${input.artifactId} has no published version. Publish it first.`);
    const r = await refreshSegment(ctx.tx, ctx.principal.workspaceId, seg, ctx.services.events, all);
    await publishInSlices(ctx.services.bus, r.changes);
    return { members: r.members, entered: r.entered, exited: r.exited };
  },
});

export const profileSegments = defineCommand({
  name: 'segments.ofProfile',
  title: 'Segments a person is in',
  description: 'The segments a person is currently a member of.',
  input: z.object({ profileId: z.string().regex(/^prf_[0-9a-f]{32}$/) }),
  output: z.object({ segments: z.array(z.object({ id: z.string(), name: z.string(), since: z.string() })) }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({ id: schema.segmentMemberships.segmentId, since: schema.segmentMemberships.since, name: schema.artifacts.name })
      .from(schema.segmentMemberships)
      .innerJoin(
        schema.artifacts,
        and(
          eq(schema.artifacts.workspaceId, schema.segmentMemberships.workspaceId),
          eq(schema.artifacts.id, schema.segmentMemberships.segmentId),
        ),
      )
      .where(eq(schema.segmentMemberships.profileId, input.profileId));
    return { segments: rows.map((r) => ({ id: r.id, name: r.name, since: r.since.toISOString() })) };
  },
});

export const segmentCommands = [previewSegment, segmentMembers, refreshSegmentCommand, profileSegments] as const;
