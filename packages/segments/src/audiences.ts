import { createHash } from 'node:crypto';
import { artifactTypes, canonicalProfileIds, createArtifact, type SegmentDefinition } from '@agentic-marketing/artifacts';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime, newId } from '@agentic-marketing/core';
import { enqueueOutbox, schema, type Tx } from '@agentic-marketing/db';
import { type BusEvent, busEventSchema } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseCsv } from './csv';
import { parseSegmentDefinition } from './definition';
import { lockSegmentMemberships } from './locks';
import { listChangeEvents, type PublishedSegment } from './membership';

// Static and snapshot audiences (#83): membership is data, not an artifact version, so editing a
// list never opens a review. The list table is the source of truth; every change is mirrored into
// segment_memberships so broadcasts, journeys and segment references keep reading one table.
// Membership is not consent: sends still check consent, suppression and delivery policy.

/**
 * The payload a `segment_change` outbox row carries: the Segment Entered/Exited events of one list
 * change, chunked so a large snapshot never writes one huge row. Validated in full, like a
 * `message_event` row: a payload that is not a complete bus event is corrupt and is failed
 * permanently instead of being published half-formed (#1102).
 */
export const segmentChangePayloadSchema = z.object({
  events: z.array(busEventSchema).min(1),
});

const SegmentId = z.string().regex(/^seg_[0-9a-f]{32}$/);
const ProfileId = z.string().regex(/^prf_[0-9a-f]{32}$/);
const MAX_BATCH = 1000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 50_000;

type ListSegment = { id: string; name: string; version: number; definition: SegmentDefinition };
type UnmatchedReason = 'not_found' | 'ambiguous' | 'invalid';
type Resolved = { profileId: string } | { reason: UnmatchedReason };
type Unmatched = { value: string; reason: UnmatchedReason };

/**
 * A test seam, set only by the concurrency tests for #1068 and #1102: it runs after the unlocked
 * follow and before the profile rows are locked, so a test can commit a merge in exactly that
 * window. Production never sets it.
 */
export const audienceTestHooks: { beforeRowLocks?: () => Promise<void> } = {};

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
  return { id, name: a.name, version: a.latestVersion, definition: parseSegmentDefinition(v.content) };
}

/**
 * Editing membership is only meaningful for a static list. A snapshot changes only through
 * audiences.refreshSnapshot: it exists so the audience can't change between review and send.
 */
function requireList(seg: ListSegment): void {
  if (seg.definition.mode === 'dynamic')
    throw new AppError(
      'invalid_input',
      `${seg.id} is a dynamic segment; its members come from its rule. Create a static segment to edit a list.`,
    );
  if (seg.definition.mode === 'snapshot')
    throw new AppError(
      'invalid_input',
      `${seg.id} is a snapshot of ${seg.definition.sourceSegment ?? 'another segment'}; it changes only with audiences.refreshSnapshot.`,
    );
}

/**
 * Follows merges so a list always holds the surviving profile. The shared merge walk (#1093)
 * resolves 256 hops and cycles; the old 20-hop frontier treated a selector 21+ merges deep as not
 * found, so it could not be added to a static list. Exported so the merge-depth test can call it.
 */
export async function canonicalOf(tx: Tx, workspaceId: string, ids: string[]): Promise<Map<string, string | null>> {
  return canonicalProfileIds(tx, workspaceId, ids);
}

/**
 * Today's people for ids resolved a moment earlier, with their profile rows locked `FOR SHARE`.
 *
 * The caller resolves identifiers before this (that step can unwrap a key with the provider); a
 * merge may commit in between. Locking the canonical rows in ascending id order — the profile row
 * order in `packages/profiles/src/identity.ts` — makes the rest race-free:
 *
 * - a merge that committed first is visible in the locked re-read, so the id is followed to its
 *   survivor;
 * - a merge that starts later must `UPDATE profiles SET merged_into` on the folded row, which
 *   conflicts with `FOR SHARE`, so it waits for this transaction. When it runs, migration 0069's
 *   `merge_segment_memberships` moves the row this transaction wrote to the survivor.
 *
 * The residual is the wait a merge takes while it holds its own identity lock; it is bounded by
 * this command's database-only work (batched inserts and deletes, no network I/O) and #1074 tracks
 * lock-wait bounds. Locking rows rather than the workspace keeps public endpoints and unrelated
 * people unblocked by a large import or snapshot.
 */
async function lockedSurvivors(tx: Tx, workspaceId: string, ids: string[]): Promise<string[]> {
  const canonical = await canonicalOf(tx, workspaceId, ids);
  let frontier = [...new Set([...canonical.values()].filter((id): id is string => !!id))];
  // The concurrency test for #1068 pauses here: the unlocked follow of a moment ago can be stale,
  // and everything after this line must re-read `merged_into` under the row lock.
  await audienceTestHooks.beforeRowLocks?.();
  const locked = new Map<string, { id: string; mergedInto: string | null }>();
  const survivors = new Set<string>();
  for (let round = 0; round < 20 && frontier.length; round++) {
    const toLock = [...new Set(frontier.filter((id) => !locked.has(id)))].sort();
    if (toLock.length) {
      const rows = (
        await tx.execute<{ id: string; merged_into: string | null }>(sql`
          SELECT id, merged_into FROM profiles
          WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(toLock)}::text[])
          ORDER BY id
          FOR SHARE`)
      ).rows;
      for (const r of rows) locked.set(r.id, { id: r.id, mergedInto: r.merged_into });
    }
    const next: string[] = [];
    for (const id of frontier) {
      if (!locked.has(id)) continue;
      const row = locked.get(id)!;
      // A merge that committed before this lock is now visible; follow it. One that starts after
      // it is waiting on the FOR SHARE and cannot move the row until this transaction commits.
      if (row.mergedInto) next.push(row.mergedInto);
      else survivors.add(id);
    }
    frontier = [...new Set(next)].filter((id) => !locked.has(id));
  }
  return [...survivors];
}

/**
 * Today's people for ids resolved a moment earlier, without taking any lock. Only a dry run, which
 * writes nothing, may use this: a write must go through `lockedSurvivors`.
 */
async function resolvedPeople(tx: Tx, workspaceId: string, ids: string[]): Promise<string[]> {
  const canonical = await canonicalOf(tx, workspaceId, ids);
  return [...new Set([...canonical.values()].filter((id): id is string => !!id))];
}

/** The people among `ids` who are already on the list. */
async function existingMembers(tx: Tx, segmentId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx
    .select({ profileId: schema.segmentListMembers.profileId })
    .from(schema.segmentListMembers)
    .where(and(eq(schema.segmentListMembers.segmentId, segmentId), inArray(schema.segmentListMembers.profileId, ids)));
  return new Set(rows.map((r) => r.profileId));
}

/**
 * Publishes list change events after the command commits. The outbox row is written in the same
 * transaction, so a process that dies after the commit still delivers on the next dispatcher round,
 * and no network I/O runs while profile rows are locked.
 */
async function enqueueSegmentChanges(tx: Tx, workspaceId: string, events: BusEvent[], cause: string) {
  const size = 5000;
  for (let i = 0; i < events.length; i += size) {
    await enqueueOutbox(tx, workspaceId, {
      kind: 'segment_change',
      payload: { events: events.slice(i, i + size) },
      operationKey: `${cause}:${i / size}`,
    });
  }
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
  };
  const [written] = await tx
    .insert(schema.segmentRuns)
    .values({ ...run, at: sql`clock_timestamp()` })
    .onConflictDoUpdate({
      target: [schema.segmentRuns.workspaceId, schema.segmentRuns.segmentId],
      // Strictly increasing, at full microsecond precision: `segments.preview` reports this stamp
      // and a client compares it, so two mutations must never share one (#771).
      set: { ...run, at: sql`GREATEST(clock_timestamp(), ${schema.segmentRuns.at} + interval '1 microsecond')` },
    })
    .returning({
      stamp: sql<string>`to_char(${schema.segmentRuns.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    });
  return written?.stamp ?? null;
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
    existing: z
      .number()
      .int()
      .describe(
        'Matched people who did not add a new row: already on the list, or folded into another matched person by a merge during the call. `added + existing` counts distinct resolved people, which can be fewer than the matched selectors',
      ),
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
    const people = await lockedSurvivors(ctx.tx, ws, resolved);
    if (!people.length) return { added: 0, existing: 0, unmatched };
    // Profile rows are held, and every writer of this segment's memberships waits here: a merge
    // that lands mid-call cannot strand a row, and no concurrent refresh or import can interleave
    // with these inserts (#1104).
    await lockSegmentMemberships(ctx.tx, [seg.id]);
    const added: string[] = [];
    for (let i = 0; i < people.length; i += MAX_BATCH) {
      const rows = await ctx.tx
        .insert(schema.segmentListMembers)
        .values(
          people.slice(i, i + MAX_BATCH).map((profileId) => ({
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
    if (entered.length) {
      const cause = `list:${newId('chg')}`;
      const events = await listChangeEvents(ctx.tx, ws, published, entered, [], cause);
      await enqueueSegmentChanges(ctx.tx, ws, events, cause);
    }
    // Count every resolved person once. `added` is the rows this call inserted, and `existing` is
    // the rest of the matched people, so the two always add up to the number of selectors that
    // resolved. Counting the survivors instead under-reported `existing` when a merge that landed
    // mid-call folded two resolved ids into one person (#1102).
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
    notMembers: z
      .number()
      .int()
      .describe(
        'Matched people who did not remove a row: already absent, or folded into another matched person by a merge during the call. `removed + notMembers` counts distinct resolved people, which can be fewer than the matched selectors',
      ),
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

    const people = await lockedSurvivors(ctx.tx, ws, resolved);
    if (!people.length) return { removed: 0, notMembers: 0, unmatched };
    // The profile rows are held; the membership lock serialises this delete with a refresh or an
    // incremental update of the same segment (#1104).
    await lockSegmentMemberships(ctx.tx, [seg.id]);
    const removedRows = await ctx.tx
      .delete(schema.segmentListMembers)
      .where(and(eq(schema.segmentListMembers.segmentId, seg.id), inArray(schema.segmentListMembers.profileId, people)))
      .returning({ profileId: schema.segmentListMembers.profileId });
    const removed = removedRows.map((r) => r.profileId);
    const exitedRows = await ctx.tx
      .delete(schema.segmentMemberships)
      .where(and(eq(schema.segmentMemberships.segmentId, seg.id), inArray(schema.segmentMemberships.profileId, people)))
      .returning({ profileId: schema.segmentMemberships.profileId });
    const exited = exitedRows.map((r) => r.profileId);

    const published = asPublished(seg);
    await recordRun(ctx.tx, ws, published, 0, exited.length);
    if (exited.length) {
      const cause = `list:${newId('chg')}`;
      const events = await listChangeEvents(ctx.tx, ws, published, [], exited, cause);
      await enqueueSegmentChanges(ctx.tx, ws, events, cause);
    }
    // Count every resolved person once. `removed` is the rows this call deleted, and `notMembers`
    // is the rest of the matched people, so the two always add up to the number of selectors that
    // resolved. Counting the survivors instead under-reported `notMembers` when a merge that landed
    // mid-call folded two resolved ids into one person (#1111).
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
    existing: z
      .number()
      .int()
      .describe(
        'Matched people who did not add a new row: already on the list, or folded into another matched person by a merge during the call. `added + existing` counts distinct resolved people, which can be fewer than the matched rows',
      ),
    unmatched: z.array(z.object({ row: z.number().int(), reason: z.enum(['not_found', 'ambiguous', 'invalid']) })),
    stamp: z
      .string()
      .nullable()
      .optional()
      .describe('When this list last changed membership, at microsecond precision; absent for a dry run'),
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
    const resolved = [...new Set(results.filter((r): r is { profileId: string } => 'profileId' in r).map((r) => r.profileId))];

    const at = new Date();
    if (input.dryRun) {
      // A dry run writes nothing, so it takes no row locks: it only answers what the import would do.
      const people = await resolvedPeople(ctx.tx, ws, resolved);
      const existing = await existingMembers(ctx.tx, seg.id, people);
      const fresh = people.filter((p) => !existing.has(p));
      return { importId: null, rows: data.length, matched, added: fresh.length, existing: resolved.length - fresh.length, unmatched };
    }

    const people = await lockedSurvivors(ctx.tx, ws, resolved);
    // After the profile rows, before the list and membership writes, as every membership writer
    // does (#1104).
    await lockSegmentMemberships(ctx.tx, [seg.id]);
    const existing = await existingMembers(ctx.tx, seg.id, people);
    const fresh = people.filter((p) => !existing.has(p));
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
    const stamp = await recordRun(ctx.tx, ws, published, entered.length, 0);
    if (entered.length) {
      const cause = `import:${newId('chg')}`;
      const events = await listChangeEvents(ctx.tx, ws, published, entered, [], cause);
      await enqueueSegmentChanges(ctx.tx, ws, events, cause);
    }
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
    return {
      importId,
      rows: data.length,
      matched,
      added: added.length,
      // Count the matched selectors, not the survivors: a merge that landed mid-call can fold two
      // resolved ids into one person, and `added + existing` must still cover every one of them
      // (#1111).
      existing: resolved.length - added.length,
      unmatched,
      stamp,
    };
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

/**
 * The profile ids a segment's membership stores, without following merges: the snapshot caller
 * locks them `FOR SHARE` and follows them to today's survivors before copying (#1068).
 */
async function memberProfileIds(tx: Tx, segmentId: string): Promise<string[]> {
  const rows = await tx
    .select({ profileId: schema.segmentMemberships.profileId })
    .from(schema.segmentMemberships)
    .where(eq(schema.segmentMemberships.segmentId, segmentId));
  return rows.map((r) => r.profileId);
}

/**
 * Makes the snapshot's stored list exactly `target`, mirroring memberships and reporting the diff.
 * `target` is the output of `lockedSurvivors`, so the profile rows are held `FOR SHARE` until this
 * transaction commits and a merge cannot strand a row on a folded id (#1068). The change events are
 * returned, not published: the caller writes them to the outbox.
 */
async function replaceList(
  ctx: CommandContext,
  seg: PublishedSegment,
  target: string[],
  source: 'snapshot',
  cause: string,
): Promise<{ added: number; removed: number; entered: number; exited: number; members: number; events: BusEvent[] }> {
  const ws = ctx.principal.workspaceId;
  // The snapshot's own membership lock, after the profile rows `lockedSurvivors` took (#1104): a
  // refresh of one snapshot is a writer of that snapshot, like any other list command.
  await lockSegmentMemberships(ctx.tx, [seg.id]);
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
  const events = entered.length || exited.length ? await listChangeEvents(ctx.tx, ws, seg, entered, exited, cause) : ([] as BusEvent[]);
  return { added: add.length, removed: remove.length, entered: entered.length, exited: exited.length, members: want.size, events };
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
    const cause = `snapshot:${newId('chg')}`;
    // The artifact rows are written first; the profile row locks come after them, consistently.
    const members = await lockedSurvivors(ctx.tx, ws, await memberProfileIds(ctx.tx, input.sourceSegmentId));
    const result = await replaceList(ctx, seg, members, 'snapshot', cause);
    if (result.events.length) await enqueueSegmentChanges(ctx.tx, ws, result.events, cause);
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
    const cause = `snapshot:${newId('chg')}`;
    const members = await lockedSurvivors(ctx.tx, ws, await memberProfileIds(ctx.tx, sourceId));
    const result = await replaceList(ctx, asPublished(seg), members, 'snapshot', cause);
    if (result.events.length) await enqueueSegmentChanges(ctx.tx, ws, result.events, cause);
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
