import { artifactTypes, type SegmentDefinition } from '@agentic-marketing/artifacts';

import { schema, type Tx } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore } from '@agentic-marketing/events';
import type { ResolvedEvent } from '@agentic-marketing/profiles';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type EvalContext, evaluate, relevant } from './evaluate';
import { materialize } from './sql';

// Keeping memberships current. A change of membership is also an event ("Segment Entered" /
// "Segment Exited") on the bus, which journeys trigger on and which lands in the event store.

export const ENTERED = 'Segment Entered';
export const EXITED = 'Segment Exited';
export const SYSTEM_SOURCE = 'system';

export interface PublishedSegment {
  id: string;
  name: string;
  version: number;
  definition: SegmentDefinition;
}

export async function publishedSegments(tx: Tx): Promise<PublishedSegment[]> {
  const rows = await tx
    .select({
      id: schema.artifacts.id,
      name: schema.artifacts.name,
      version: schema.artifacts.publishedVersion,
      content: schema.artifactVersions.content,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(and(eq(schema.artifacts.type, 'segment'), isNotNull(schema.artifacts.publishedVersion), eq(schema.artifacts.archived, false)));
  return rows.map((r) => ({ id: r.id, name: r.name, version: r.version ?? 0, definition: artifactTypes.segment.content.parse(r.content) }));
}

export function contextFor(
  tx: Tx,
  workspaceId: string,
  events: EventStore,
  segments: PublishedSegment[],
  extra: Partial<EvalContext> = {},
): EvalContext {
  const byId = new Map(segments.map((s) => [s.id, s.definition]));
  return { tx, workspaceId, events, loadSegment: async (id) => byId.get(id) ?? null, ...extra };
}

interface Changed {
  profileId: string;
  userId: string;
  anonymousId: string;
}

/** The event a membership change becomes, about the person through one of their ids. */
function changeEvent(workspaceId: string, seg: PublishedSegment, c: Changed, name: string, cause: string): BusEvent | null {
  if (!c.userId && !c.anonymousId) return null;
  const now = new Date().toISOString();
  return {
    workspaceId,
    sourceId: SYSTEM_SOURCE,
    // Stable for the same cause, so a retried batch publishes duplicates that JetStream drops.
    messageId: `seg:${seg.id}:${c.profileId}:${name === ENTERED ? 'in' : 'out'}:${cause}`,
    type: 'track',
    name,
    anonymousId: c.anonymousId,
    userId: c.userId,
    timestamp: now,
    receivedAt: now,
    properties: { segment_id: seg.id, segment_name: seg.name, segment_version: seg.version, profile_id: c.profileId },
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  };
}

/** Change events for a few people (streaming), looking up their ids. */
async function membershipEvents(
  tx: Tx,
  workspaceId: string,
  seg: PublishedSegment,
  entered: string[],
  exited: string[],
  cause: (profileId: string) => string,
): Promise<BusEvent[]> {
  const people = [...entered, ...exited];
  if (!people.length) return [];
  const ids = await tx
    .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
    .from(schema.identifiers)
    .where(and(inArray(schema.identifiers.profileId, people), inArray(schema.identifiers.type, ['user_id', 'anonymous_id'])));
  const who = (profileId: string): Changed => ({
    profileId,
    userId: ids.find((i) => i.profileId === profileId && i.type === 'user_id')?.value ?? '',
    anonymousId: ids.find((i) => i.profileId === profileId && i.type === 'anonymous_id')?.value ?? '',
  });
  return [
    ...entered.map((p) => changeEvent(workspaceId, seg, who(p), ENTERED, cause(p))),
    ...exited.map((p) => changeEvent(workspaceId, seg, who(p), EXITED, cause(p))),
  ].filter((e): e is BusEvent => !!e);
}

/** Publishes in slices, so a refresh that moves a million people does not hold a million pending acks. */
export async function publishInSlices(bus: EventBus, events: BusEvent[], size = 5000) {
  for (let i = 0; i < events.length; i += size) await bus.publish(events.slice(i, i + size));
}

async function applyDiff(tx: Tx, workspaceId: string, segId: string, members: Set<string>, scope?: string[]) {
  const current = new Set(
    (
      await tx
        .select({ profileId: schema.segmentMemberships.profileId })
        .from(schema.segmentMemberships)
        .where(
          and(
            eq(schema.segmentMemberships.segmentId, segId),
            scope ? inArray(schema.segmentMemberships.profileId, scope.length ? scope : ['-']) : undefined,
          ),
        )
    ).map((r) => r.profileId),
  );
  const entered = [...members].filter((p) => !current.has(p));
  const exited = [...current].filter((p) => !members.has(p));
  for (let i = 0; i < entered.length; i += 1000)
    await tx
      .insert(schema.segmentMemberships)
      .values(entered.slice(i, i + 1000).map((profileId) => ({ workspaceId, segmentId: segId, profileId })))
      .onConflictDoNothing();
  for (let i = 0; i < exited.length; i += 1000)
    await tx
      .delete(schema.segmentMemberships)
      .where(and(eq(schema.segmentMemberships.segmentId, segId), inArray(schema.segmentMemberships.profileId, exited.slice(i, i + 1000))));
  return { entered, exited };
}

/**
 * Recomputes a whole segment in SQL (see sql.ts), stores the difference and returns the change
 * events to publish. Only the people who entered or left pass through memory.
 */
export async function refreshSegment(tx: Tx, workspaceId: string, seg: PublishedSegment, events: EventStore, all: PublishedSegment[]) {
  const started = Date.now();
  const members = await materialize(seg.definition.condition, contextFor(tx, workspaceId, events, all));
  // The diff lands in a temporary table first, so the id lookup below is planned with real row counts.
  const changed = `seg_changed_${members.table.slice('seg_members_'.length)}`;
  await tx.execute(sql.raw(`CREATE TEMP TABLE ${changed} (profile_id text PRIMARY KEY, entered boolean NOT NULL) ON COMMIT DROP`));
  await tx.execute(sql`
    WITH ins AS (
      INSERT INTO segment_memberships (workspace_id, segment_id, profile_id)
      SELECT ${workspaceId}, ${seg.id}, m.profile_id FROM ${sql.raw(members.table)} m
      WHERE NOT EXISTS (SELECT 1 FROM segment_memberships s WHERE s.segment_id = ${seg.id} AND s.profile_id = m.profile_id)
      ON CONFLICT DO NOTHING
      RETURNING profile_id)
    INSERT INTO ${sql.raw(changed)} SELECT profile_id, true FROM ins`);
  await tx.execute(sql`
    WITH del AS (
      DELETE FROM segment_memberships s
      WHERE s.segment_id = ${seg.id} AND NOT EXISTS (SELECT 1 FROM ${sql.raw(members.table)} m WHERE m.profile_id = s.profile_id)
      RETURNING profile_id)
    INSERT INTO ${sql.raw(changed)} SELECT profile_id, false FROM del`);
  await tx.execute(sql.raw(`ANALYZE ${changed}`));
  // Each changed person with an id their change event is about.
  type Row = { profile_id: string; entered: boolean; user_id: string; anonymous_id: string; merged: boolean };
  const rows = (
    await tx.execute<Row>(sql`
      SELECT c.profile_id, c.entered,
        coalesce(max(i.value) FILTER (WHERE i.type = 'user_id'), '') AS user_id,
        coalesce(max(i.value) FILTER (WHERE i.type = 'anonymous_id'), '') AS anonymous_id,
        bool_or(p.merged_into IS NOT NULL) AS merged
      FROM ${sql.raw(changed)} c
      LEFT JOIN identifiers i ON i.workspace_id = ${workspaceId} AND i.profile_id = c.profile_id AND i.type IN ('user_id', 'anonymous_id')
      LEFT JOIN profiles p ON p.workspace_id = ${workspaceId} AND p.id = c.profile_id
      GROUP BY c.profile_id, c.entered`)
  ).rows;
  const entered = rows.filter((r) => r.entered);
  const exited = rows.filter((r) => !r.entered);
  const runId = new Date().toISOString().slice(0, 16);
  const changes: BusEvent[] = [];
  const add = (r: Row, name: string) => {
    const e = changeEvent(
      workspaceId,
      seg,
      { profileId: r.profile_id, userId: r.user_id, anonymousId: r.anonymous_id },
      name,
      `run:${runId}`,
    );
    if (e) changes.push(e);
  };
  for (const r of entered) add(r, ENTERED);
  // People merged into others leave quietly: they still exist, as part of someone else.
  for (const r of exited) if (!r.merged) add(r, EXITED);
  const run = {
    workspaceId,
    segmentId: seg.id,
    version: seg.version,
    members: members.size,
    entered: entered.length,
    exited: exited.length,
    tookMs: Date.now() - started,
    at: new Date(),
  };
  await tx
    .insert(schema.segmentRuns)
    .values(run)
    .onConflictDoUpdate({ target: [schema.segmentRuns.workspaceId, schema.segmentRuns.segmentId], set: run });
  return {
    members: members.size,
    entered: entered.length,
    exited: exited.length,
    changes,
    changedProfiles: [...entered.map((r) => r.profile_id), ...exited.map((r) => r.profile_id)],
  };
}

/**
 * Streaming: re-evaluates the segments an event batch can affect, for the people in it only.
 * Returns the change events to publish.
 */
export async function streamUpdate(tx: Tx, workspaceId: string, resolved: ResolvedEvent[], events: EventStore): Promise<BusEvent[]> {
  const useful = resolved.filter((r) => r.event.sourceId !== SYSTEM_SOURCE);
  if (!useful.length) return [];
  const segments = await publishedSegments(tx);
  const out: BusEvent[] = [];
  for (const seg of segments) {
    const touched = useful.filter((r) => relevant(seg.definition.condition, r.event));
    if (!touched.length) continue;
    const scope = [...new Set(touched.map((r) => r.profileId))];
    const pending = new Map<string, BusEvent[]>();
    for (const r of useful) pending.set(r.profileId, [...(pending.get(r.profileId) ?? []), r.event]);
    const members = await evaluate(seg.definition.condition, contextFor(tx, workspaceId, events, segments, { scope, pending }));
    const { entered, exited } = await applyDiff(tx, workspaceId, seg.id, members, scope);
    const lastEvent = new Map(touched.map((r) => [r.profileId, r.event.messageId]));
    out.push(...(await membershipEvents(tx, workspaceId, seg, entered, exited, (p) => lastEvent.get(p) ?? 'stream')));
  }
  return out;
}

/**
 * Re-evaluates every segment for a few people after a change that reaches no event stream, such
 * as an unsubscribe link writing consent. Returns the change events to publish.
 */
export async function refreshPeople(tx: Tx, workspaceId: string, profileIds: string[], events: EventStore, cause: string) {
  const scope = [...new Set(profileIds)];
  if (!scope.length) return [];
  const segments = await publishedSegments(tx);
  const out: BusEvent[] = [];
  for (const seg of segments) {
    const members = await evaluate(seg.definition.condition, contextFor(tx, workspaceId, events, segments, { scope }));
    const { entered, exited } = await applyDiff(tx, workspaceId, seg.id, members, scope);
    out.push(...(await membershipEvents(tx, workspaceId, seg, entered, exited, () => cause)));
  }
  return out;
}

/** The after-resolve hook for the profile workers. */
export function segmentHook(deps: {
  db: { withWorkspace: <T>(ws: string, fn: (tx: Tx) => Promise<T>) => Promise<T> };
  events: EventStore;
  bus: EventBus;
}) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    // Publish before the commit: if the commit fails the batch is retried and JetStream drops
    // the repeated events (stable ids); publishing after it could lose them.
    await deps.db.withWorkspace(workspaceId, async (tx) => {
      const changes = await streamUpdate(tx, workspaceId, resolved, deps.events);
      if (changes.length) await deps.bus.publish(changes);
    });
  };
}
