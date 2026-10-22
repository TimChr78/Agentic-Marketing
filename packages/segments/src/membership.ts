import { artifactTypes, type SegmentDefinition } from '@agentic-marketing/artifacts';

import { schema, type Tx } from '@agentic-marketing/db';
import type { BusEvent, EventBus, EventStore } from '@agentic-marketing/events';
import type { ResolvedEvent } from '@agentic-marketing/profiles';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { type EvalContext, evaluate, relevant } from './evaluate';

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

/** The event a membership change becomes, about the person through one of their ids. */
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
  const now = new Date().toISOString();
  const make = (profileId: string, name: string): BusEvent | null => {
    const userId = ids.find((i) => i.profileId === profileId && i.type === 'user_id')?.value ?? '';
    const anonymousId = ids.find((i) => i.profileId === profileId && i.type === 'anonymous_id')?.value ?? '';
    if (!userId && !anonymousId) return null;
    return {
      workspaceId,
      sourceId: SYSTEM_SOURCE,
      // Stable for the same cause, so a retried batch publishes duplicates that JetStream drops.
      messageId: `seg:${seg.id}:${profileId}:${name === ENTERED ? 'in' : 'out'}:${cause(profileId)}`,
      type: 'track',
      name,
      anonymousId,
      userId,
      timestamp: now,
      receivedAt: now,
      properties: { segment_id: seg.id, segment_name: seg.name, segment_version: seg.version, profile_id: profileId },
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
    };
  };
  return [...entered.map((p) => make(p, ENTERED)), ...exited.map((p) => make(p, EXITED))].filter((e): e is BusEvent => !!e);
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

/** Recomputes a whole segment, stores the difference and returns the change events to publish. */
export async function refreshSegment(tx: Tx, workspaceId: string, seg: PublishedSegment, events: EventStore, all: PublishedSegment[]) {
  const started = Date.now();
  const members = await evaluate(seg.definition.condition, contextFor(tx, workspaceId, events, all));
  const { entered, exited } = await applyDiff(tx, workspaceId, seg.id, members);
  // People merged into others leave quietly: they still exist, as part of someone else.
  const merged = new Set(
    exited.length
      ? (
          await tx
            .select({ id: schema.profiles.id })
            .from(schema.profiles)
            .where(and(inArray(schema.profiles.id, exited), isNotNull(schema.profiles.mergedInto)))
        ).map((r) => r.id)
      : [],
  );
  const runId = new Date().toISOString().slice(0, 16);
  const changes = await membershipEvents(
    tx,
    workspaceId,
    seg,
    entered,
    exited.filter((p) => !merged.has(p)),
    () => `run:${runId}`,
  );
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
  return { members: members.size, entered: entered.length, exited: exited.length, changes, changedProfiles: [...entered, ...exited] };
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
