import { createHash } from 'node:crypto';
import { artifactTypes, createArtifact, type SegmentDefinition } from '@agentic-marketing/artifacts';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime, newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseCsv } from './csv';
import { listChangeEvents, type PublishedSegment, publishInSlices } from './membership';

// Static and snapshot audiences (#83): membership is data, not an artifact version, so editing a
// list never opens a review. The list table is the source of truth; every change is mirrored into
// segment_memberships so broadcasts, journeys and segment references keep reading one table.
// Membership is not consent: sends still check consent, suppression and delivery policy.

const SegmentId = z.string().regex(/^seg_[0-9a-f]{32}$/);
const ProfileId = z.string().regex(/^prf_[0-9a-f]{32}$/);
const MAX_BATCH = 1000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 50_000;

type ListSegment = { id: string; name: string; version: number; definition: SegmentDefinition };
type UnmatchedReason = 'not_found' | 'ambiguous' | 'invalid';
type Resolved = { profileId: string } | { reason: UnmatchedReason };
type Unmatched = { value: string; reason: UnmatchedReason };

/** The latest version of a segment, which is what an edit acts on. */
async function latestSegment(tx: Tx, workspaceId: string, id: string): Promise<ListSegment> {
  const [a] = await tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, id), eq(schema.artifacts.type, 'segment')));
  if (!a) throw new AppError('not_found', `No segment ${id}.`);
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, id), eq(schema.artifactVersions.number, a.latestVersion)));
  if (!v) throw new AppError('not_found', `Segment ${id} has no content.`);
  return { id, name: a.name, version: a.latestVersion, definition: artifactTypes.segment.content.parse(v.content) };
}

/** Editing membership is only meaningful for a stored list. */
function requireList(seg: ListSegment): void {
  if (seg.definition.mode === 'dynamic')
    throw new AppError(
      'invalid_input',
      `${seg.id} is a dynamic segment; its members come from its rule. Create a static or snapshot segment to edit a list.`,
    );
}

/** Follows merges so a list always holds the surviving profile. */
async function canonicalOf(tx: Tx, workspaceId: string, ids: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  let frontier = new Map([...new Set(ids)].map((id) => [id, id] as const));
  for (let round = 0; round < 20 && frontier.size; round++) {
    const current = [...new Set(frontier.values())];
    const rows = await tx
      .select({ id: schema.profiles.id, mergedInto: schema.profiles.mergedInto })
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, workspaceId), inArray(schema.profiles.id, current)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const next = new Map<string, string>();
    for (const [input, id] of frontier) {
      const p = byId.get(id);
      if (!p) result.set(input, null);
      else if (p.mergedInto) next.set(input, p.mergedInto);
      else result.set(input, id);
    }
    frontier = next;
  }
  for (const input of frontier.keys()) result.set(input, null);
  return result;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Resolves identifiers in the caller's order without ever returning personal values from the database. */
async function resolveMany(
  ctx: CommandContext,
  kind: 'email' | 'user_id' | 'profile_id',
  values: string[],
): Promise<{ results: Resolved[]; resolved: string[]; unmatched: Unmatched[] }> {
  const ws = ctx.principal.workspaceId;
  const crypto = personCrypto(ctx.tx, ws, ctx.services.keyProvider);
  const results: Resolved[] = new Array(values.length);
  const lookups: { index: number; value: string; key: string }[] = [];
  const unmatched: Unmatched[] = [];

  for (const [index, raw] of values.entries()) {
    const value = raw.trim();
    if (!value) {
      results[index] = { reason: 'invalid' };
      unmatched.push({ value: raw, reason: 'invalid' });
      continue;
    }
    if (kind === 'profile_id') {
      if (!/^prf_[0-9a-f]{32}$/.test(value)) {
        results[index] = { reason: 'invalid' };
        unmatched.push({ value, reason: 'invalid' });
      } else lookups.push({ index, value, key: value });
    } else if (kind === 'email') {
      if (value.length > 320 || !EMAIL.test(value)) {
        results[index] = { reason: 'invalid' };
        unmatched.push({ value, reason: 'invalid' });
      } else lookups.push({ index, value, key: await crypto.matchHash('email', value) });
    } else {
      if (value.length > 200) {
        results[index] = { reason: 'invalid' };
        unmatched.push({ value, reason: 'invalid' });
      } else lookups.push({ index, value, key: value });
    }
  }

  if (!lookups.length) return { results, resolved: [], unmatched };

  const rows =
    kind === 'profile_id'
      ? await ctx.tx
          .select({ profileId: schema.profiles.id, key: schema.profiles.id })
          .from(schema.profiles)
          .where(
            and(
              eq(schema.profiles.workspaceId, ws),
              inArray(
                schema.profiles.id,
                lookups.map((l) => l.key),
              ),
            ),
          )
      : await ctx.tx
          .select({ profileId: schema.identifiers.profileId, key: schema.identifiers.value })
          .from(schema.identifiers)
          .where(
            and(
              eq(schema.identifiers.workspaceId, ws),
              eq(schema.identifiers.type, kind === 'email' ? 'email' : 'user_id'),
              inArray(
                schema.identifiers.value,
                lookups.map((l) => l.key),
              ),
            ),
          );

  const hits = new Map<string, Set<string>>();
  for (const row of rows) hits.set(row.key, new Set([...(hits.get(row.key) ?? []), row.profileId]));
  const canonical = await canonicalOf(
    ctx.tx,
    ws,
    [...hits.values()].flatMap((set) => [...set]),
  );

  for (const lookup of lookups) {
    const found = hits.get(lookup.key);
    if (!found) {
      results[lookup.index] = { reason: 'not_found' };
      unmatched.push({ value: lookup.value, reason: 'not_found' });
    } else if (found.size > 1) {
      results[lookup.index] = { reason: 'ambiguous' };
      unmatched.push({ value: lookup.value, reason: 'ambiguous' });
    } else {
      const id = canonical.get([...found][0]);
      if (!id) {
        results[lookup.index] = { reason: 'not_found' };
        unmatched.push({ value: lookup.value, reason: 'not_found' });
      } else results[lookup.index] = { profileId: id };
    }
  }

  const resolved = [...new Set(results.filter((r): r is { profileId: string } => 'profileId' in r).map((r) => r.profileId))];
  return { results, resolved, unmatched };
}

const selectorShape = {
  profileIds: z.array(ProfileId).max(MAX_BATCH).optional().describe('Profile ids (prf_…)'),
  emails: z.array(z.string().min(1).max(320)).max(MAX_BATCH).optional().describe('E-mail addresses, matched by hash'),
  userIds: z.array(z.string().min(1).max(200)).max(MAX_BATCH).optional().describe('External user ids'),
};

const selectorCount = (v: { profileIds?: string[]; emails?: string[]; userIds?: string[] }) =>
  (v.profileIds?.length ?? 0) + (v.emails?.length ?? 0) + (v.userIds?.length ?? 0);

const Selector = z
  .object(selectorShape)
  .refine((v) => selectorCount(v) <= MAX_BATCH, `At most ${MAX_BATCH} people per call.`)
  .refine((v) => selectorCount(v) > 0, 'Pass at least one profileId, e-mail or user id.');

const ListSelector = z
  .object({ segmentId: SegmentId, ...selectorShape })
  .refine((v) => selectorCount(v) <= MAX_BATCH, `At most ${MAX_BATCH} people per call.`)
  .refine((v) => selectorCount(v) > 0, 'Pass at least one profileId, e-mail or user id.');

async function resolveSelectors(ctx: CommandContext, input: z.output<typeof Selector>) {
  const groups = await Promise.all([
    resolveMany(ctx, 'profile_id', input.profileIds ?? []),
    resolveMany(ctx, 'email', input.emails ?? []),
    resolveMany(ctx, 'user_id', input.userIds ?? []),
  ]);
  return {
    resolved: [...new Set(groups.flatMap((g) => g.resolved))],
    unmatched: groups.flatMap((g) => g.unmatched),
  };
}

/** Recomputes the visible count in segment_runs, which segments.members and the UI read. */
async function recordRun(tx: Tx, workspaceId: string, seg: PublishedSegment, entered: number, exited: number) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.segmentMemberships)
    .where(eq(schema.segmentMemberships.segmentId, seg.id));
  const run = {
    workspaceId,
    segmentId: seg.id,
    version: seg.version,
    members: row?.n ?? 0,
    entered,
    exited,
    tookMs: 0,
    at: new Date(),
  };
  await tx
    .insert(schema.segmentRuns)
    .values(run)
    .onConflictDoUpdate({ target: [schema.segmentRuns.workspaceId, schema.segmentRuns.segmentId], set: run });
}

/** Publishes list change events before the command commits; stable ids make a retried batch harmless. */
async function publishChanges(ctx: CommandContext, seg: PublishedSegment, entered: string[], exited: string[], cause: string) {
  if (!entered.length && !exited.length) return [] as BusEvent[];
  const events = await listChangeEvents(ctx.tx, ctx.principal.workspaceId, seg, entered, exited, cause);
  await publishInSlices(ctx.services.bus, events);
  return events;
}

function asPublished(seg: ListSegment, definition = seg.definition): PublishedSegment {
  return { id: seg.id, name: seg.name, version: seg.version, definition };
}

export const addAudienceMembers = defineCommand({
  name: 'audiences.add',
  title: 'Add people to a static audience',
  description:
    'Add up to 1,000 people to a static or snapshot segment by profile id, e-mail or user id. Adding someone twice changes nothing. Membership is not consent: sends still check consent, suppression and delivery policy.',
  input: ListSelector.extend({
    source: z.enum(['manual', 'api']).default('api').describe('Where the addition came from, kept per member'),
  })
    .refine((v) => selectorCount(v) <= MAX_BATCH, `At most ${MAX_BATCH} people per call.`)
    .refine((v) => selectorCount(v) > 0, 'Pass at least one profileId, e-mail or user id.'),
  output: z.object({
    added: z.number().int(),
    existing: z.number().int().describe('People who were already on the list'),
    unmatched: z.array(z.object({ value: z.string(), reason: z.enum(['not_found', 'ambiguous', 'invalid']) })),
  }),
  permission: 'profiles:write',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.segmentId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const seg = await latestSegment(ctx.tx, ws, input.segmentId);
    requireList(seg);
    const { resolved, unmatched } = await resolveSelectors(ctx, input);
    if (!resolved.length) return { added: 0, existing: 0, unmatched };

    const at = new Date();
    const added: string[] = [];
    for (let i = 0; i < resolved.length; i += MAX_BATCH) {
      const rows = await ctx.tx
        .insert(schema.segmentListMembers)
        .values(
          resolved.slice(i, i + MAX_BATCH).map((profileId) => ({
            workspaceId: ws,
            segmentId: seg.id,
            profileId,
            addedAt: at,
            addedBy: ctx.principal.userId,
            source: input.source,
          })),
        )
        .onConflictDoNothing()
        .returning({ profileId: schema.segmentListMembers.profileId });
      added.push(...rows.map((r) => r.profileId));
    }

    // Mirror into segment_memberships; only people new to the membership are entered.
    const entered: string[] = [];
    for (let i = 0; i < added.length; i += MAX_BATCH) {
      const rows = await ctx.tx
        .insert(schema.segmentMemberships)
        .values(added.slice(i, i + MAX_BATCH).map((profileId) => ({ workspaceId: ws, segmentId: seg.id, profileId })))
        .onConflictDoNothing()
        .returning({ profileId: schema.segmentMemberships.profileId });
      entered.push(...rows.map((r) => r.profileId));
    }

    const published = asPublished(seg);
    await recordRun(ctx.tx, ws, published, entered.length, 0);
    if (entered.length) await publishChanges(ctx, published, entered, [], `list:${newId('chg')}`);
    return { added: added.length, existing: resolved.length - added.length, unmatched };
  },
});

export const removeAudienceMembers = defineCommand({
  name: 'audiences.remove',
  title: 'Remove people from a static audience',
  description:
    'Remove up to 1,000 people from a static or snapshot segment by profile id, e-mail or user id. Removing someone who is not on the list changes nothing.',
  input: ListSelector,
  output: z.object({
    removed: z.number().int(),
    notMembers: z.number().int().describe('People resolved but not on the list'),
    unmatched: z.array(z.object({ value: z.string(), reason: z.enum(['not_found', 'ambiguous', 'invalid']) })),
  }),
  permission: 'profiles:write',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.segmentId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const seg = await latestSegment(ctx.tx, ws, input.segmentId);
    requireList(seg);
    const { resolved, unmatched } = await resolveSelectors(ctx, input);
    if (!resolved.length) return { removed: 0, notMembers: 0, unmatched };

    const removedRows = await ctx.tx
      .delete(schema.segmentListMembers)
      .where(and(eq(schema.segmentListMembers.segmentId, seg.id), inArray(schema.segmentListMembers.profileId, resolved)))
      .returning({ profileId: schema.segmentListMembers.profileId });
    const removed = removedRows.map((r) => r.profileId);
    const exitedRows = await ctx.tx
      .delete(schema.segmentMemberships)
      .where(and(eq(schema.segmentMemberships.segmentId, seg.id), inArray(schema.segmentMemberships.profileId, resolved)))
      .returning({ profileId: schema.segmentMemberships.profileId });
    const exited = exitedRows.map((r) => r.profileId);

    const published = asPublished(seg);
    await recordRun(ctx.tx, ws, published, 0, exited.length);
    if (exited.length) await publishChanges(ctx, published, [], exited, `list:${newId('chg')}`);
    return { removed: removed.length, notMembers: resolved.length - removed.length, unmatched };
  },
});

async function recordImport(
  tx: Tx,
  workspaceId: string,
  segmentId: string,
  input: {
    source: 'csv' | 'snapshot';
    rows: number;
    matched: number;
    added: number;
    unmatched: { row: number; reason: string }[];
    fileName?: string | null;
    fileSha256?: string | null;
    actor: string | null;
  },
) {
  const id = newId('sli');
  await tx.insert(schema.segmentListImports).values({
    workspaceId,
    id,
    segmentId,
    fileName: input.fileName ?? null,
    fileSha256: input.fileSha256 ?? null,
    rows: input.rows,
    matched: input.matched,
    added: input.added,
    unmatched: input.unmatched,
    actor: input.actor,
    source: input.source,
  });
  return id;
}

export const importAudienceCsv = defineCommand({
  name: 'audiences.import',
  title: 'Import people into a static audience from CSV',
  description:
    'Parse a CSV (up to 5 MB) and add the people in one column to a static or snapshot segment. Use dryRun to preview matches and unmatched rows before applying; re-importing adds nobody twice. Ids are matched by e-mail hash, user id or profile id. Unmatched rows are reported by row number and reason only, without personal data. Membership is not consent.',
  input: z.object({
    segmentId: SegmentId,
    csv: z.string().min(1).max(MAX_IMPORT_BYTES).describe('The file contents as text'),
    column: z.string().min(1).max(200).describe('Header of the column holding the identifier'),
    idType: z.enum(['email', 'user_id', 'profile_id']),
    fileName: z.string().max(255).optional(),
    dryRun: z.boolean().default(false).describe('Match and count without changing the list'),
  }),
  output: z.object({
    importId: z.string().nullable().describe('Null for a dry run'),
    rows: z.number().int(),
    matched: z.number().int().describe('Rows whose identifier resolved to a person'),
    added: z.number().int().describe('People newly on the list'),
    existing: z.number().int().describe('People already on the list'),
    unmatched: z.array(z.object({ row: z.number().int(), reason: z.enum(['not_found', 'ambiguous', 'invalid']) })),
  }),
  permission: 'profiles:write',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.segmentId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const seg = await latestSegment(ctx.tx, ws, input.segmentId);
    requireList(seg);
    if (Buffer.byteLength(input.csv, 'utf8') > MAX_IMPORT_BYTES) throw new AppError('invalid_input', 'The CSV is larger than 5 MB.');
    const parsed = parseCsv(input.csv);
    if (!parsed.length) throw new AppError('invalid_input', 'The CSV is empty.');
    const header = parsed[0];
    const index = header.findIndex((h) => h.trim().toLowerCase() === input.column.trim().toLowerCase());
    if (index < 0)
      throw new AppError('invalid_input', `The CSV has no column "${input.column}". Columns: ${header.map((h) => h.trim()).join(', ')}.`);
    const data = parsed.slice(1);
    if (!data.length) throw new AppError('invalid_input', 'The CSV has a header but no rows.');
    if (data.length > MAX_IMPORT_ROWS)
      throw new AppError('invalid_input', `The CSV has ${data.length} rows; the limit is ${MAX_IMPORT_ROWS}.`);

    const values = data.map((row) => (row[index] ?? '').trim());
    const { results } = await resolveMany(ctx, input.idType, values);
    const unmatched = results.flatMap((r, i) => ('reason' in r ? [{ row: i + 2, reason: r.reason }] : []));
    const matched = results.length - unmatched.length;
    const people = [...new Set(results.filter((r): r is { profileId: string } => 'profileId' in r).map((r) => r.profileId))];

    const existingRows = people.length
      ? await ctx.tx
          .select({ profileId: schema.segmentListMembers.profileId })
          .from(schema.segmentListMembers)
          .where(and(eq(schema.segmentListMembers.segmentId, seg.id), inArray(schema.segmentListMembers.profileId, people)))
      : [];
    const existing = new Set(existingRows.map((r) => r.profileId));
    const fresh = people.filter((p) => !existing.has(p));

    if (input.dryRun) {
      return { importId: null, rows: data.length, matched, added: fresh.length, existing: people.length - fresh.length, unmatched };
    }

    const at = new Date();
    const added: string[] = [];
    for (let i = 0; i < fresh.length; i += MAX_BATCH) {
      const rows = await ctx.tx
        .insert(schema.segmentListMembers)
        .values(
          fresh.slice(i, i + MAX_BATCH).map((profileId) => ({
            workspaceId: ws,
            segmentId: seg.id,
            profileId,
            addedAt: at,
            addedBy: ctx.principal.userId,
            source: 'csv' as const,
          })),
        )
        .onConflictDoNothing()
        .returning({ profileId: schema.segmentListMembers.profileId });
      added.push(...rows.map((r) => r.profileId));
    }

    const entered: string[] = [];
    for (let i = 0; i < added.length; i += MAX_BATCH) {
      const rows = await ctx.tx
        .insert(schema.segmentMemberships)
        .values(added.slice(i, i + MAX_BATCH).map((profileId) => ({ workspaceId: ws, segmentId: seg.id, profileId })))
        .onConflictDoNothing()
        .returning({ profileId: schema.segmentMemberships.profileId });
      entered.push(...rows.map((r) => r.profileId));
    }

    const published = asPublished(seg);
    await recordRun(ctx.tx, ws, published, entered.length, 0);
    if (entered.length) await publishChanges(ctx, published, entered, [], `import:${newId('chg')}`);
    const importId = await recordImport(ctx.tx, ws, seg.id, {
      source: 'csv',
      rows: data.length,
      matched,
      added: added.length,
      unmatched,
      fileName: input.fileName ?? null,
      fileSha256: createHash('sha256').update(input.csv).digest('hex'),
      actor: ctx.principal.userId,
    });
    return { importId, rows: data.length, matched, added: added.length, existing: people.length - added.length, unmatched };
  },
});

export const listAudienceImports = defineCommand({
  name: 'audiences.imports',
  title: 'Import history of a static audience',
  description:
    'Recent CSV imports and snapshot refreshes of a segment: counts, file name, hash and who did it. Unmatched rows are row numbers and reasons only. Membership in the list is not consent to receive anything.',
  input: z.object({ segmentId: SegmentId, limit: z.number().int().min(1).max(100).default(20), before: isoDateTime('before').optional() }),
  output: z.object({
    imports: z.array(
      z.object({
        id: z.string(),
        source: z.enum(['csv', 'snapshot']),
        fileName: z.string().nullable(),
        fileSha256: z.string().nullable(),
        rows: z.number().int(),
        matched: z.number().int(),
        added: z.number().int(),
        unmatched: z.array(z.object({ row: z.number().int(), reason: z.string() })),
        actor: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.segmentListImports)
      .where(
        and(
          eq(schema.segmentListImports.segmentId, input.segmentId),
          input.before ? lt(schema.segmentListImports.createdAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(schema.segmentListImports.createdAt))
      .limit(input.limit);
    return {
      imports: rows.map((r) => ({
        id: r.id,
        source: r.source,
        fileName: r.fileName,
        fileSha256: r.fileSha256,
        rows: r.rows,
        matched: r.matched,
        added: r.added,
        unmatched: r.unmatched,
        actor: r.actor,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

/** The surviving members of a segment, for a snapshot copy. */
async function memberIds(tx: Tx, workspaceId: string, segmentId: string): Promise<string[]> {
  const rows = await tx
    .select({ profileId: schema.segmentMemberships.profileId })
    .from(schema.segmentMemberships)
    .innerJoin(
      schema.profiles,
      and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, schema.segmentMemberships.profileId)),
    )
    .where(and(eq(schema.segmentMemberships.segmentId, segmentId), sql`${schema.profiles.mergedInto} IS NULL`));
  return rows.map((r) => r.profileId);
}

/** Makes the snapshot's stored list exactly `target`, mirroring memberships and reporting the diff. */
async function replaceList(
  ctx: CommandContext,
  seg: PublishedSegment,
  target: string[],
  source: 'snapshot',
): Promise<{ added: number; removed: number; entered: number; exited: number; members: number }> {
  const ws = ctx.principal.workspaceId;
  const want = new Set(target);
  const currentRows = await ctx.tx
    .select({ profileId: schema.segmentListMembers.profileId })
    .from(schema.segmentListMembers)
    .where(eq(schema.segmentListMembers.segmentId, seg.id));
  const current = new Set(currentRows.map((r) => r.profileId));
  const add = [...want].filter((p) => !current.has(p));
  const remove = [...current].filter((p) => !want.has(p));

  for (let i = 0; i < add.length; i += MAX_BATCH)
    await ctx.tx
      .insert(schema.segmentListMembers)
      .values(
        add.slice(i, i + MAX_BATCH).map((profileId) => ({
          workspaceId: ws,
          segmentId: seg.id,
          profileId,
          addedBy: ctx.principal.userId,
          source,
        })),
      )
      .onConflictDoNothing();
  for (let i = 0; i < remove.length; i += MAX_BATCH)
    await ctx.tx
      .delete(schema.segmentListMembers)
      .where(
        and(eq(schema.segmentListMembers.segmentId, seg.id), inArray(schema.segmentListMembers.profileId, remove.slice(i, i + MAX_BATCH))),
      );

  const entered: string[] = [];
  for (let i = 0; i < add.length; i += MAX_BATCH) {
    const rows = await ctx.tx
      .insert(schema.segmentMemberships)
      .values(add.slice(i, i + MAX_BATCH).map((profileId) => ({ workspaceId: ws, segmentId: seg.id, profileId })))
      .onConflictDoNothing()
      .returning({ profileId: schema.segmentMemberships.profileId });
    entered.push(...rows.map((r) => r.profileId));
  }
  const exited: string[] = [];
  for (let i = 0; i < remove.length; i += MAX_BATCH) {
    const rows = await ctx.tx
      .delete(schema.segmentMemberships)
      .where(
        and(eq(schema.segmentMemberships.segmentId, seg.id), inArray(schema.segmentMemberships.profileId, remove.slice(i, i + MAX_BATCH))),
      )
      .returning({ profileId: schema.segmentMemberships.profileId });
    exited.push(...rows.map((r) => r.profileId));
  }

  await recordRun(ctx.tx, ws, seg, entered.length, exited.length);
  await publishChanges(ctx, seg, entered, exited, `snapshot:${newId('chg')}`);
  return { added: add.length, removed: remove.length, entered: entered.length, exited: exited.length, members: want.size };
}

export const snapshotAudience = defineCommand({
  name: 'audiences.snapshot',
  title: 'Snapshot a segment',
  description:
    'Create a draft snapshot segment from another segment’s current members and the source’s published version, frozen until refreshed with audiences.refreshSnapshot. It still needs the normal approval before it can be used. Use it when the audience must not change between review and send. Membership is not consent.',
  input: z.object({
    sourceSegmentId: SegmentId.describe('The segment to freeze (its published version and current members)'),
    name: z.string().min(1).max(120),
    note: z.string().max(500).optional().describe('Why this snapshot exists, shown to reviewers'),
  }),
  output: z.object({ artifactId: z.string(), version: z.number().int(), members: z.number().int() }),
  permission: 'profiles:write',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.sourceSegmentId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const [source] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(
        and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, input.sourceSegmentId), eq(schema.artifacts.type, 'segment')),
      );
    if (!source) throw new AppError('not_found', `No segment ${input.sourceSegmentId}.`);
    if (!source.publishedVersion) throw new AppError('conflict', `Publish ${input.sourceSegmentId} before snapshotting its members.`);

    const content = {
      description: `Snapshot of ${source.name} (v${source.publishedVersion})`,
      mode: 'snapshot' as const,
      sourceSegment: input.sourceSegmentId,
      snapshotAt: new Date().toISOString(),
      snapshotVersion: source.publishedVersion,
    };
    const created = await createArtifact.handler(
      { type: 'segment', name: input.name, content, note: input.note ?? `Snapshot of ${source.name} v${source.publishedVersion}` },
      ctx,
    );
    const seg: PublishedSegment = {
      id: created.artifactId,
      name: input.name,
      version: created.version,
      definition: artifactTypes.segment.content.parse(content),
    };
    const members = await memberIds(ctx.tx, ws, input.sourceSegmentId);
    const result = await replaceList(ctx, seg, members, 'snapshot');
    await recordImport(ctx.tx, ws, seg.id, {
      source: 'snapshot',
      rows: members.length,
      matched: members.length,
      added: result.added,
      unmatched: [],
      actor: ctx.principal.userId,
    });
    return { artifactId: seg.id, version: seg.version, members: result.members };
  },
});

export const refreshSnapshotAudience = defineCommand({
  name: 'audiences.refreshSnapshot',
  title: 'Refresh a snapshot audience',
  description:
    'Re-copy the source segment’s current members into a snapshot, recording an import row with source "snapshot" and emitting Segment Entered/Exited for the change. The snapshot’s content and source version stay as they were, so this is a data change, not an artifact version. Membership is not consent.',
  input: z.object({ segmentId: SegmentId }),
  output: z.object({
    members: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    entered: z.number().int(),
    exited: z.number().int(),
    importId: z.string(),
  }),
  permission: 'profiles:write',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.segmentId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const seg = await latestSegment(ctx.tx, ws, input.segmentId);
    if (seg.definition.mode !== 'snapshot' || !seg.definition.sourceSegment)
      throw new AppError('invalid_input', `${input.segmentId} is not a snapshot segment.`);
    const sourceId = seg.definition.sourceSegment;
    const [source] = await ctx.tx
      .select({ publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ws), eq(schema.artifacts.id, sourceId)));
    if (!source?.publishedVersion) throw new AppError('conflict', `The snapshot's source ${sourceId} is not published.`);
    const members = await memberIds(ctx.tx, ws, sourceId);
    const result = await replaceList(ctx, asPublished(seg), members, 'snapshot');
    const importId = await recordImport(ctx.tx, ws, seg.id, {
      source: 'snapshot',
      rows: members.length,
      matched: members.length,
      added: result.added,
      unmatched: [],
      actor: ctx.principal.userId,
    });
    return {
      members: result.members,
      added: result.added,
      removed: result.removed,
      entered: result.entered,
      exited: result.exited,
      importId,
    };
  },
});

export const audienceListCommands = [
  addAudienceMembers,
  removeAudienceMembers,
  importAudienceCsv,
  listAudienceImports,
  snapshotAudience,
  refreshSnapshotAudience,
] as const;
