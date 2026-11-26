import { artifactTypes, canonicalPeople, DEFAULT_PURPOSES, type JourneyDefinition, publishedSingleton } from '@agentic-marketing/artifacts';
import { type PublishedCampaign, publishedCampaigns } from '@agentic-marketing/campaigns';
import { AppError, hashValue, newId, safeErrorText, sleep } from '@agentic-marketing/core';
import { assertJourneyEventAgeBound, type Db, enqueueOutbox, JOURNEY_EVENT_MAX_AGE_DAYS, schema, type Tx } from '@agentic-marketing/db';
import { fingerprintParts, requestEmail, requestPush, requestSms, sendRequestHash } from '@agentic-marketing/email';
import type { EventStore, JourneyEvent } from '@agentic-marketing/events';
import {
  canonicalProfile,
  consentStateOf,
  currentConsent,
  dropErasedProfileRows,
  erasedProfileIdsInTx,
  lockProfileRows,
  purposeAllowed,
  type ResolvedEvent,
  refusedPurposes,
  withIdentityLock,
} from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { contextFor, ENTERED, evaluate, publishedSegments, relevant } from '@agentic-marketing/segments';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import jsonata from 'jsonata';
import { matchesCondition } from './conditions';
import { duplicateEntryKey, noteEntrySkip, resolveEntryKey } from './entry';
import { compile, type Graph } from './graph';
import { assignHoldout, holdoutDetail } from './holdout';
import { type AiOutcome, advance, type Effect, type ParticipantState } from './interpreter';
import { noteJourneyEventTooOld } from './metrics';

// The journey runtime (ADR-0004): trigger matching and wake-ups run as a post-commit hook of the
// profile workers; the sweeper (worker role) advances due participants in batches.

export interface JourneyDeps {
  kp: KeyProvider;
  events: EventStore;
}

const graphs = new Map<string, Graph>();

/** How many due candidates one sweep may examine, per unit of its batch. */
const SCAN_LIMIT_FACTOR = 10;
/** Advance attempts before a participant whose step failed transiently is failed for good (#1240). */
const MAX_ADVANCE_ATTEMPTS = 3;
/** Backoff after a transient advance failure: 15 s, then 30 s — a store restart is usually shorter. */
const advanceRetryDelayMs = (attempts: number) => Math.min(300_000, 15_000 * 2 ** Math.max(0, attempts - 1));
/**
 * Where each workspace's last bounded scan stopped, so the next sweep continues past a run of
 * people another transaction is writing instead of re-examining them (and never walks a whole
 * workspace backlog in one round). A scan that reached the end of the due set, or filled its batch,
 * clears its entry and starts from the oldest again.
 */
const scanCursors = new Map<string, { dueAt: Date; id: string }>();

/** The compiled graph of a journey version (versions are immutable, so it is cached forever). */
async function graphOf(tx: Tx, journeyId: string, version: number): Promise<Graph> {
  const key = `${journeyId}@${version}`;
  const hit = graphs.get(key);
  if (hit) return hit;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, journeyId), eq(schema.artifactVersions.number, version)));
  const g = compile(artifactTypes.journey.content.parse(v.content) as JourneyDefinition);
  if (graphs.size > 1000) graphs.clear();
  graphs.set(key, g);
  return g;
}

export interface PublishedJourney {
  id: string;
  version: number;
  graph: Graph;
}

export async function publishedJourneys(tx: Tx): Promise<PublishedJourney[]> {
  const rows = await tx
    .select({ id: schema.artifacts.id, version: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.type, 'journey'), isNotNull(schema.artifacts.publishedVersion), eq(schema.artifacts.archived, false)));
  const out: PublishedJourney[] = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, version: r.version ?? 0, graph: await graphOf(tx, r.id, r.version ?? 0) });
    } catch (err) {
      logger.error({ err, journey: r.id }, 'published journey does not compile');
    }
  }
  return out;
}

/**
 * Enters people into journeys whose trigger the events match. The caller holds the workspace
 * identity lock (`withIdentityLock`): this runs after the batch that resolved the events, so a merge
 * may have committed in between, and the canonical lookup below is only truthful while no merge can
 * interleave. Without both, a participant could be inserted against an id that was already folded
 * away (#1011).
 */
export async function enterJourneys(
  tx: Tx,
  workspaceId: string,
  resolved: ResolvedEvent[],
): Promise<{ entered: number; holdout: JourneyEvent[]; enrolled: { eventId: string; profileId: string }[] }> {
  if (!resolved.length) return { entered: 0, holdout: [], enrolled: [] };
  // Follow a merge that committed after the batch. SQL only: nothing personal is decrypted here.
  const canonical = await canonicalPeople(
    tx,
    workspaceId,
    resolved.map((r) => r.profileId),
  );
  const journeys = await publishedJourneys(tx);
  // A campaign's control group is the outer scope: its sending members inherit the campaign's
  // assignment instead of randomising the same person again. Loaded once per batch.
  const campaignOf = new Map<string, PublishedCampaign>();
  for (const c of await publishedCampaigns(tx))
    if (c.content.controlGroup) for (const m of c.content.members) campaignOf.set(m.artifactId, c);
  let entered = 0;
  const holdout: JourneyEvent[] = [];
  // The events whose processing inserted a participant, with the person they enrolled. They get a
  // durable processed marker, so a redelivery cannot enrol the same event twice (#1011 review), and
  // the marker names the person so an erasure removes it (an event id can carry an address).
  const enrolled = new Map<string, string>();
  for (const { event: e, profileId: resolvedId } of resolved) {
    const profileId = canonical.get(resolvedId) ?? resolvedId;
    for (const j of journeys) {
      const t = j.graph.trigger;
      const hit = t.event ? t.event === e.name && e.name !== ENTERED : e.name === ENTERED && e.properties.segment_id === t.segment;
      if (!hit) continue;
      const choice = resolveEntryKey(t, e);
      if (!choice) {
        await noteEntrySkip(tx, workspaceId, j.id, 'missing');
        continue;
      }
      // A configured business key composes with re-entry: once per key, after_exit per active
      // key, always ignores the key. Without it the old profile-based rule stays.
      const keyed = !!t.event && t.entryKey?.source === 'event_property';
      if (t.reentry !== 'always') {
        if (keyed) {
          if (await duplicateEntryKey(tx, j.id, choice.key, t.reentry)) {
            await noteEntrySkip(tx, workspaceId, j.id, 'duplicate');
            continue;
          }
        } else {
          const [prior] = await tx
            .select({ status: schema.journeyParticipants.status })
            .from(schema.journeyParticipants)
            .where(
              and(
                eq(schema.journeyParticipants.journeyId, j.id),
                eq(schema.journeyParticipants.profileId, profileId),
                t.reentry === 'after_exit' ? inArray(schema.journeyParticipants.status, ['ready', 'waiting']) : undefined,
              ),
            )
            .limit(1);
          if (prior) continue;
        }
      }
      // The arm is chosen at entry, before the sweeper can send anything. Entry itself does not
      // check consent; sends do, so the control group is drawn from everyone who entered. A journey
      // inside a campaign with a control group uses the campaign's arm, not its own.
      const campaign = campaignOf.get(j.id);
      const assigned = campaign
        ? await assignHoldout(tx, workspaceId, { type: 'campaign', id: campaign.id }, campaign.content.controlGroup, profileId)
        : await assignHoldout(tx, workspaceId, { type: 'journey', id: j.id }, j.graph.controlGroup, profileId);
      const res = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId,
          journeyId: j.id,
          version: j.version,
          profileId,
          // "always" ignores the business key, so every delivery is its own participant.
          entryKey: t.reentry === 'always' ? e.messageId : choice.key,
          node: j.graph.start,
          status: 'ready',
          dueAt: new Date(),
          context: {
            event: { name: e.name, properties: e.properties },
            ...(assigned
              ? {
                  holdout: {
                    ...assigned.assignment,
                    scope: campaign ? 'campaign' : 'journey',
                    ...(campaign ? { campaignId: campaign.id } : {}),
                  },
                }
              : {}),
          },
        })
        .onConflictDoNothing()
        .returning({ id: schema.journeyParticipants.id });
      if (!res.length) {
        if (keyed) await noteEntrySkip(tx, workspaceId, j.id, 'duplicate');
        continue;
      }
      entered += res.length;
      enrolled.set(e.messageId, profileId);
      if (assigned?.created)
        holdout.push({
          workspaceId,
          // A campaign assignment belongs to the campaign scope, so its event names the campaign
          // even when a journey entry happened to assign it first.
          journeyId: campaign?.id ?? j.id,
          version: campaign?.version ?? j.version,
          participantId: res[0]!.id,
          profileId,
          node: j.graph.start,
          type: 'holdout_assigned',
          seq: 0,
          at: new Date().toISOString(),
          detail: holdoutDetail(assigned.assignment, campaign?.id),
        });
    }
  }
  return { entered, holdout, enrolled: [...enrolled].map(([eventId, profileId]) => ({ eventId, profileId })) };
}

/**
 * Wakes the people already waiting for one of this batch's events (wait-for-event and goal nodes).
 * SQL only, so it runs in the same transaction as the enrolment: a participant this event enrols is
 * `ready`, never `waiting`, and therefore cannot be woken by the event that created it (#1011
 * review).
 *
 * Returns the (event, person) pairs that woke at least one participant, so the caller can record
 * the same processed marker an enrolment writes. Without it an event that only wakes a wait has no
 * marker, and a redelivery wakes whatever the participant waits for later — including a second
 * wait or goal on the same event name (#1052).
 */
export async function wakeWaiters(
  tx: Tx,
  workspaceId: string,
  resolved: ResolvedEvent[],
): Promise<{ eventId: string; profileId: string }[]> {
  if (!resolved.length) return [];
  // Same merge-following reason as `enterJourneys` (#1011).
  const canonical = await canonicalPeople(
    tx,
    workspaceId,
    resolved.map((r) => r.profileId),
  );
  const woken: { eventId: string; profileId: string }[] = [];
  for (const r of resolved) {
    const profileId = canonical.get(r.profileId) ?? r.profileId;
    const w = await tx.execute(sql`
      UPDATE journey_participants SET matched = true, waiting_event = NULL, due_at = now(), updated_at = now()
      WHERE workspace_id = ${workspaceId} AND profile_id = ${profileId} AND waiting_event = ${r.event.name} AND status = 'waiting'`);
    if (w.rowCount) woken.push({ eventId: r.event.messageId, profileId });
  }
  return woken;
}

/**
 * How old a delivery may be, measured from the event's receive time (#1027). Kept in the database
 * package beside the marker retention, because it has to stay strictly inside it.
 */
const MAX_EVENT_AGE_MS = JOURNEY_EVENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
/**
 * How far ahead of the local clock a receive time may be before it is treated as a clock problem
 * (#1027). No ingest path stamps a future time, but replicas' clocks differ by seconds; anything
 * beyond this cannot be trusted to describe the delivery.
 */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether an event is young enough to apply (#1027). The age is measured from `receivedAt`, the
 * server's own receive time: it is written at ingest and every redelivery carries it unchanged. The
 * event's `timestamp` is the sender's and may be deliberately historical (an import of an old
 * signup, a backfill), so it says when something happened, not when the delivery arrived, and
 * cannot prove a redelivery is fresh. A receive time that cannot be read proves nothing at all, and
 * one more than a few minutes in the future is a clock problem rather than a fresh delivery; both
 * are treated as too old.
 */
export function withinDeliveryAge(receivedAt: string, now: number): boolean {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received)) return false;
  const age = now - received;
  return age <= MAX_EVENT_AGE_MS && age >= -MAX_FUTURE_SKEW_MS;
}

/**
 * The batch's events that are young enough to apply (#1027). The others are refused here, before
 * the transaction and before any write: an event the stream replays after its marker was pruned
 * must not enrol its person again or satisfy a wait, and a marker is never needed for it because
 * the age check refuses every later delivery too. They are counted and logged at debug level; no
 * event id goes into the line, because a caller-supplied id can name the person.
 */
function recentEvents(resolved: ResolvedEvent[], now = Date.now()): ResolvedEvent[] {
  const recent: ResolvedEvent[] = [];
  for (const r of resolved) {
    if (withinDeliveryAge(r.event.receivedAt, now)) {
      recent.push(r);
      continue;
    }
    noteJourneyEventTooOld();
    const age = now - Date.parse(r.event.receivedAt);
    logger.debug(
      { event: r.event.name, ageDays: Number.isFinite(age) ? Math.round(age / (24 * 60 * 60 * 1000)) : null },
      'journey event ignored: received before the delivery-age bound (#1027)',
    );
  }
  return recent;
}

/**
 * The events of this batch the journey hook has not applied yet. A redelivered event has a row from
 * the transaction that enrolled someone, or woke someone waiting for it, and is skipped entirely:
 * its enrolment and the wake-up it caused happened exactly once (#1011 review, #1052).
 *
 * The age bound in `recentEvents` keeps this marker's window honest for both kinds (#1027): an
 * event is only applied while a delivery of it is young enough that the marker written then still
 * exists, so a pruned marker can never re-enable the same event.
 */
async function freshEvents(tx: Tx, workspaceId: string, resolved: ResolvedEvent[]): Promise<ResolvedEvent[]> {
  if (!resolved.length) return [];
  const ids = [...new Set(resolved.map((r) => r.event.messageId))];
  const rows = await tx.execute<{ event_id: string }>(sql`
    SELECT event_id FROM journey_processed_events
    WHERE workspace_id = ${workspaceId} AND event_id = ANY(${sql.param(ids)}::text[])`);
  const done = new Set(rows.rows.map((r) => r.event_id));
  return resolved.filter((r) => !done.has(r.event.messageId));
}

/**
 * Records the events this hook applied, in that same transaction: each event that enrolled someone
 * or woke a waiting participant. The table has one row per event (an event belongs to exactly one
 * person), so an event that both enrolled and woke someone still writes one row.
 */
async function markProcessed(tx: Tx, workspaceId: string, applied: { eventId: string; profileId: string }[]): Promise<void> {
  if (!applied.length) return;
  const byEvent = new Map<string, string>();
  for (const row of applied) if (!byEvent.has(row.eventId)) byEvent.set(row.eventId, row.profileId);
  await tx.execute(sql`
    INSERT INTO journey_processed_events (workspace_id, event_id, profile_id)
    VALUES ${sql.join(
      [...byEvent].map(([eventId, profileId]) => sql`(${workspaceId}, ${eventId}, ${profileId})`),
      sql`, `,
    )}
    ON CONFLICT DO NOTHING`);
}

/**
 * Re-evaluates wait-until participants of the people this batch touched. It reads only those
 * people's participants; a journey-wide or all-profile scan never happens here.
 */
async function wakeWaitUntil(tx: Tx, workspaceId: string, resolved: ResolvedEvent[], deps: JourneyDeps) {
  const byProfile = new Map<string, ResolvedEvent[]>();
  for (const r of resolved) byProfile.set(r.profileId, [...(byProfile.get(r.profileId) ?? []), r]);
  if (!byProfile.size) return;
  const waiting = await tx
    .select({
      id: schema.journeyParticipants.id,
      journeyId: schema.journeyParticipants.journeyId,
      version: schema.journeyParticipants.version,
      profileId: schema.journeyParticipants.profileId,
      node: schema.journeyParticipants.node,
    })
    .from(schema.journeyParticipants)
    .where(
      and(
        eq(schema.journeyParticipants.workspaceId, workspaceId),
        inArray(schema.journeyParticipants.profileId, [...byProfile.keys()]),
        eq(schema.journeyParticipants.status, 'waiting'),
      ),
    );
  if (!waiting.length) return;
  const segments = await publishedSegments(tx);
  for (const p of waiting) {
    const events = byProfile.get(p.profileId) ?? [];
    try {
      const graph = await graphOf(tx, p.journeyId, p.version);
      const node = graph.nodes.get(p.node);
      if (node?.kind !== 'waitUntil') continue;
      if (!events.some(({ event }) => relevant(node.condition, event))) continue;
      const pending = new Map([[p.profileId, events.map(({ event }) => event)]]);
      if (!(await matchesCondition(tx, workspaceId, deps.events, segments, p.profileId, node.condition, pending))) continue;
      await tx.execute(sql`
        UPDATE journey_participants SET matched = true, due_at = now(), updated_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${p.id} AND status = 'waiting' AND matched = false`);
    } catch (err) {
      // A broken condition should not swallow the whole batch; the sweeper will fail the
      // participant at its next check or its timeout.
      logger.warn({ err, participant: p.id }, 'wait-until re-evaluation failed');
    }
  }
}

/**
 * The after-resolve hook for the profile workers. One event is applied once, however often the
 * batch is delivered.
 */
export function journeyHook(db: Db, deps: JourneyDeps) {
  // Startup assertion (#1027): the age bound has to stay inside the marker retention, and a
  // drifted constant must fail here instead of silently re-enabling duplicate enrolments.
  assertJourneyEventAgeBound();
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    if (!resolved.length) return;
    // Refused before the transaction: an event past the age bound neither enrols nor wakes anyone,
    // for this delivery or a later replay (#1027).
    const recent = recentEvents(resolved);
    if (!recent.length) return;
    let holdout: JourneyEvent[] = [];
    // One transaction for the writes an event causes: enrolment and the wake-up of the people
    // already waiting for it see the same state, so a participant this event enrols cannot be woken
    // by it and a sweeper tick cannot run in between (#1011 review). The workspace identity lock
    // keeps a merge from interleaving, and no network I/O runs under it.
    await db.withWorkspace(workspaceId, (tx) =>
      withIdentityLock(tx, workspaceId, async () => {
        const fresh = await freshEvents(tx, workspaceId, recent);
        if (!fresh.length) return;
        const entered = await enterJourneys(tx, workspaceId, fresh);
        holdout = entered.holdout;
        const woken = await wakeWaiters(tx, workspaceId, fresh);
        // Enrolment and waking both spend the event: either one writes the marker that keeps a
        // redelivery from applying it again, to this or a later node (#1052).
        await markProcessed(tx, workspaceId, [...entered.enrolled, ...woken]);
      }),
    );
    // Wait-until conditions may reach ClickHouse, so this recheck runs in its own transaction,
    // without the lock. It is idempotent, and the sweeper rechecks the same conditions later. It
    // sees the same age-filtered batch, so an old replay cannot satisfy a wait here either (#1027).
    await db.withWorkspace(workspaceId, (tx) => wakeWaitUntil(tx, workspaceId, recent, deps));
    // ClickHouse is outside the transaction: an assignment that committed but whose event did not
    // is still measured from the table, and a lost event only affects the timeline.
    if (holdout.length) {
      const kept = await dropErasedProfileRows(db, workspaceId, holdout);
      if (kept.length) await deps.events.insertJourneyEvents(kept).catch((err) => logger.warn({ err }, 'holdout events not stored'));
    }
  };
}

/** Fallback texts of a generate prompt's slots (its published version). */
async function fallbackContent(tx: Tx, promptId: string): Promise<Record<string, string>> {
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
    .where(eq(schema.artifacts.id, promptId));
  const slots = (row?.content as { slots?: { name: string; fallback: string }[] } | undefined)?.slots ?? [];
  return Object.fromEntries(slots.map((s) => [s.name, s.fallback]));
}

type Participant = typeof schema.journeyParticipants.$inferSelect;

/** What JSONata expressions in automation steps see: the person (non-personal traits) and the participant's context. */
async function scopeOf(tx: Tx, p: Participant) {
  const [prof] = await tx.select({ traits: schema.profiles.traits }).from(schema.profiles).where(eq(schema.profiles.id, p.profileId));
  const c = p.context as Record<string, unknown>;
  return {
    profile: { id: p.profileId, traits: prof?.traits ?? {} },
    event: c.event,
    vars: c.vars ?? {},
    content: c.content ?? {},
    results: c.results ?? {},
  };
}

/**
 * An exception's text for a participant error or a stored journey detail (#885). The expression and
 * the condition are the workspace's own, so the message stays useful; a credential a person put in
 * an expression, or one a service echoed, is redacted while the text is complete.
 */
export function journeyErrorText(err: unknown): string {
  // JSONata throws a plain object with a `message`, not an Error, so read the field first.
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown } | null)?.message === 'string'
        ? String((err as { message: string }).message)
        : String(err);
  return safeErrorText(message, 500);
}

/**
 * JSONata returns objects without a prototype; plain JSON is what the database and receivers get.
 * A failure is rethrown with sanitized text: `$error("password=…")` ends up in a participant's
 * `error` and in the context a person reads (#885).
 */
export const evalJsonata = async (expression: string, scope: unknown): Promise<unknown> => {
  try {
    const v = await jsonata(expression).evaluate(scope);
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  } catch (err) {
    throw new Error(journeyErrorText(err), { cause: err });
  }
};

async function saveContext(tx: Tx, workspaceId: string, p: Participant) {
  await tx
    .update(schema.journeyParticipants)
    .set({ context: p.context })
    .where(and(eq(schema.journeyParticipants.workspaceId, workspaceId), eq(schema.journeyParticipants.id, p.id)));
}

/** The agent that owns the journey whose step sends this message (#426); null for a person's journey. */
async function journeyOwnerAgentId(tx: Tx, journeyId: string): Promise<string | null> {
  const [a] = await tx
    .select({ ownerAgentId: schema.artifacts.ownerAgentId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, journeyId));
  return a?.ownerAgentId ?? null;
}

async function webhookAllowed(tx: Tx, workspaceId: string, profileId: string, purpose: string) {
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const basis = purposes.find((x) => x.key === purpose)?.basis ?? 'consent';
  const state = currentConsent(await consentStateOf(tx, workspaceId, profileId), purpose, 'webhook');
  return purposeAllowed(basis, state?.status);
}

async function applyEffect(
  tx: Tx,
  workspaceId: string,
  p: Participant,
  eff: Effect,
  deps: JourneyDeps,
  graph: Graph,
  flags: { wakeNow: boolean; control: boolean },
): Promise<string | null> {
  if (eff.kind === 'transform') {
    try {
      const value = await evalJsonata(eff.expression, await scopeOf(tx, p));
      p.context = { ...p.context, vars: { ...((p.context.vars as Record<string, unknown>) ?? {}), [eff.set]: value ?? null } };
      await saveContext(tx, workspaceId, p);
      return `vars.${eff.set} = ${JSON.stringify(value ?? null).slice(0, 200)}`;
    } catch (err) {
      return `transform failed: ${journeyErrorText(err)}`;
    }
  }
  if (eff.kind === 'webhook') {
    if (!(await webhookAllowed(tx, workspaceId, p.profileId, graph.purpose)))
      return `not sent: no lawful basis for purpose "${graph.purpose}"`;
    const scope = await scopeOf(tx, p);
    let data: unknown = { profile: scope.profile, event: scope.event };
    if (eff.data)
      try {
        data = await evalJsonata(eff.data, scope);
      } catch (err) {
        return `not sent: the data expression failed: ${journeyErrorText(err)}`;
      }
    await tx
      .insert(schema.deliveries)
      .values({
        workspaceId,
        id: newId('dlv'),
        kind: 'webhook',
        targetId: eff.endpoint,
        payload: {
          type: 'journey.webhook',
          timestamp: new Date().toISOString(),
          data: { journey: { id: p.journeyId, version: p.version, node: eff.node }, ...(data as object) },
        },
        status: 'pending',
        idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
        profileId: p.profileId,
      })
      .onConflictDoNothing();
    return 'webhook queued';
  }
  if (eff.kind === 'action') {
    let input: unknown = eff.input;
    try {
      if (typeof eff.input === 'string') input = await evalJsonata(eff.input, await scopeOf(tx, p));
    } catch (err) {
      // No point waiting for the timeout: take the error edge on the next sweep.
      const results = (p.context.results as Record<string, unknown>) ?? {};
      p.context = {
        ...p.context,
        results: { ...results, [eff.node]: { seq: eff.seq, ok: false, error: `input: ${journeyErrorText(err)}` } },
      };
      await saveContext(tx, workspaceId, p);
      flags.wakeNow = true;
      return null;
    }
    await tx
      .insert(schema.deliveries)
      .values({
        workspaceId,
        id: newId('dlv'),
        kind: 'action',
        targetId: eff.connection,
        action: eff.action,
        payload: (input ?? {}) as object,
        status: 'pending',
        idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
        participantId: p.id,
        node: eff.node,
        seq: eff.seq,
        profileId: p.profileId,
      })
      .onConflictDoNothing();
    return null;
  }
  if (eff.kind === 'ai') {
    // The AI worker answers outside this transaction and wakes the participant.
    await tx
      .insert(schema.aiCalls)
      .values({
        workspaceId,
        id: newId('aic'),
        kind: eff.task,
        status: 'pending',
        idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
        promptId: eff.task === 'score' ? null : eff.prompt,
        journeyId: p.journeyId,
        participantId: p.id,
        node: eff.node,
        seq: eff.seq,
        profileId: p.profileId,
        input: {
          trigger: (p.context as { event?: unknown }).event ?? null,
          ...(eff.task === 'score' && eff.questions
            ? {
                questions: eff.questions,
                threshold: eff.threshold,
                ...(eff.answer ? { answer: eff.answer } : {}),
                scoreKey: eff.scoreKey ?? eff.questions[0]?.key,
              }
            : {}),
        },
      })
      .onConflictDoNothing();
    return null;
  }
  if (eff.kind === 'aiFallback') {
    const content = { ...((p.context.content as Record<string, string> | undefined) ?? {}), ...(await fallbackContent(tx, eff.prompt)) };
    p.context = { ...p.context, content };
    await tx
      .update(schema.journeyParticipants)
      .set({ context: p.context })
      .where(and(eq(schema.journeyParticipants.workspaceId, workspaceId), eq(schema.journeyParticipants.id, p.id)));
    return null;
  }
  // A journey step's identity is the participant (enrollment), the pinned node and its sequence:
  // never the resolved profile (a merge changes it) or a template resolved at send time. A worker
  // retry after re-rendering or a merge must replay the message it already queued (#926).
  const journeyHash = (channel: 'email' | 'sms' | 'push') =>
    sendRequestHash(
      channel,
      fingerprintParts.journey({
        journey: p.journeyId,
        enrollment: p.id,
        step: eff.node,
        sequence: eff.seq,
      }),
    );
  if (eff.kind === 'email') {
    if (flags.control) return 'skipped: control';
    const d = await requestEmail(tx, workspaceId, deps.kp, {
      profileId: p.profileId,
      templateId: eff.template,
      idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
      journeyId: p.journeyId,
      data: p.context,
      agentId: await journeyOwnerAgentId(tx, p.journeyId),
      requestHash: journeyHash('email'),
    });
    return `e-mail ${d.status}${d.reason ? `: ${d.reason}` : ''}`;
  }
  if (eff.kind === 'sms') {
    if (flags.control) return 'skipped: control';
    const d = await requestSms(tx, workspaceId, deps.kp, {
      profileId: p.profileId,
      templateId: eff.template,
      idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
      journeyId: p.journeyId,
      data: p.context,
      agentId: await journeyOwnerAgentId(tx, p.journeyId),
      requestHash: journeyHash('sms'),
    });
    return `SMS ${d.status}${d.reason ? `: ${d.reason}` : ''}`;
  }
  if (eff.kind === 'push') {
    if (flags.control) return 'skipped: control';
    const d = await requestPush(tx, workspaceId, deps.kp, {
      profileId: p.profileId,
      templateId: eff.template,
      idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
      journeyId: p.journeyId,
      data: p.context,
      agentId: await journeyOwnerAgentId(tx, p.journeyId),
      requestHash: journeyHash('push'),
    });
    return `push ${d.status}${d.reason ? `: ${d.reason}` : ''}`;
  }
  // Only non-personal traits; personal data never comes from a journey definition.
  const plan = await publishedSingleton(tx, 'tracking_plan');
  const def = plan?.traits.find((x) => x.name === eff.trait);
  if (def && def.pii !== 'none') return `skipped: ${eff.trait} is personal data`;
  // A participant can sit on the id its person was merged away from (a hook that ran after the
  // merge, before #1011), so follow the merge in SQL only, and never report a write that matched no
  // row as if it happened (#1011).
  const person = await canonicalProfile(tx, workspaceId, p.profileId);
  if (!person) return `skipped: ${eff.trait} not written: the person no longer exists`;
  const written = await tx.execute(sql`
    UPDATE profiles SET traits = jsonb_set(traits, ARRAY[${eff.trait}], ${JSON.stringify(eff.value)}::jsonb), updated_at = now()
    WHERE workspace_id = ${workspaceId} AND id = ${person.id} AND merged_into IS NULL`);
  if (!written.rowCount) return `skipped: ${eff.trait} not written: the person was merged away or erased`;
  return `${eff.trait} = ${JSON.stringify(eff.value)}`;
}

/**
 * Queues a sweep's journey events in the same transaction as the participant rows (#1244). One
 * outbox row per journey carries them; the stable operation key makes a re-enqueue a no-op and the
 * dispatcher retries the ClickHouse insert, so a failed write no longer loses a split take, a goal
 * conversion or a step count. The payload's profile ids let an erasure's outbox cleanup remove it.
 */
async function enqueueJourneyEvents(tx: Tx, workspaceId: string, events: JourneyEvent[]): Promise<void> {
  if (!events.length) return;
  // An erasure may already have recorded the person. The direct write filtered these rows before it
  // ran; the outbox row names the profile id, so keep them out before a dispatcher can publish them.
  const erased = await erasedProfileIdsInTx(
    tx,
    workspaceId,
    events.map((event) => event.profileId),
  );
  const kept = erased.size ? events.filter((event) => !erased.has(event.profileId)) : events;
  if (!kept.length) return;
  const byJourney = new Map<string, JourneyEvent[]>();
  for (const event of kept) {
    const group = byJourney.get(event.journeyId);
    if (group) group.push(event);
    else byJourney.set(event.journeyId, [event]);
  }
  for (const [journeyId, group] of byJourney) {
    // The event identity is the whole content of the row, so replaying the same batch enqueues
    // nothing new; ClickHouse's replacing key collapses a duplicate even if two rows survive.
    const identities = group.map((event) => `${event.participantId}:${event.seq}:${event.type}:${event.at}`).sort();
    await enqueueOutbox(tx, workspaceId, {
      kind: 'journey_event',
      operationKey: `journey-event:${hashValue({ journeyId, events: identities })}`,
      subjectRef: journeyId,
      payload: { events: group },
    });
  }
}

/**
 * One sweep: per workspace, lock the due people's profile rows, claim their due participants,
 * advance them, apply effects and write states in one transaction. Returns how many participants
 * moved. See the row order in `packages/profiles/src/identity.ts`: profile rows are locked first and
 * never waited for, which keeps a sweep and an SDK batch from deadlocking (#1011).
 */
export async function sweep(db: Db, deps: JourneyDeps, opts: { batch?: number; now?: () => Date } = {}): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const batch = opts.batch ?? 200;
  // The workspace whose people have been due longest goes first (#1245). A plain `DISTINCT
  // workspace_id LIMIT 100` came back in plan order (by workspace_id), so a workspace with a
  // backlog kept its slot every round and every workspace past the first 100 starved.
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM journey_participants
     WHERE status IN ('ready', 'waiting') AND due_at <= $1
     GROUP BY workspace_id
     ORDER BY min(due_at), workspace_id
     LIMIT 100`,
    [now()],
  );
  let moved = 0;
  for (const { workspace_id: ws } of rows) {
    const journeyEvents: JourneyEvent[] = [];
    // One workspace whose claim or commit fails (a dead connection, a lock timeout) must not stop
    // the round before the others: each workspace is its own transaction, and the next sweep gets
    // another chance at this one.
    try {
      moved += await db.withWorkspace(ws, async (tx) => {
        // Profile rows first: the people due now, resolved to the profile they belong to today (a
        // participant can sit on an id a merge folded away). Locking them before any participant row
        // is the order every writer uses (#1011); SKIP LOCKED means this transaction never waits for a
        // row a batch or a merge holds, so it cannot be the second half of a lock cycle.
        //
        // Candidates are read in due order, oldest first, and the scan goes on past someone whose
        // profile is locked until the batch is filled or no candidates are left: a locked person must
        // not spend the batch, and due time — not the profile id — decides who moves first (#1011
        // review).
        const claimable: string[] = [];
        const scanLimit = Math.max(1, batch * SCAN_LIMIT_FACTOR);
        let after = scanCursors.get(ws);
        let scanned = 0;
        let reachedEnd = false;
        while (claimable.length < batch && scanned < scanLimit) {
          const want = Math.min(batch - claimable.length, scanLimit - scanned);
          const page = await tx.execute<{ id: string; profile_id: string; due_at: Date }>(sql`
          SELECT id, profile_id, due_at FROM journey_participants
          WHERE status IN ('ready', 'waiting') AND due_at <= ${now()}
            ${after ? sql`AND (due_at, id) > (${after.dueAt}::timestamptz, ${after.id}::bigint)` : sql``}
          ORDER BY due_at, id LIMIT ${want}`);
          if (!page.rows.length) {
            reachedEnd = true;
            break;
          }
          const last = page.rows[page.rows.length - 1]!;
          after = { dueAt: last.due_at, id: last.id };
          scanned += page.rows.length;
          const canonical = await canonicalPeople(
            tx,
            ws,
            page.rows.map((r) => r.profile_id),
          );
          const roots = [...new Set(page.rows.map((r) => canonical.get(r.profile_id) ?? r.profile_id))];
          // The lock carries `merged_into IS NULL`, so a merge that committed after the lookup above
          // leaves nothing locked for that person: the candidate is deferred to the next sweep instead
          // of claiming a participant row whose survivor this transaction does not hold.
          const locked = new Set(await lockProfileRows(tx, ws, roots, { skipLocked: true }));
          for (const row of page.rows) {
            const root = canonical.get(row.profile_id) ?? row.profile_id;
            if (locked.has(root)) claimable.push(row.id);
          }
          if (page.rows.length < want) {
            reachedEnd = true;
            break;
          }
        }
        if (reachedEnd || claimable.length >= batch) scanCursors.delete(ws);
        else if (after) scanCursors.set(ws, after);
        if (scanCursors.size > 10_000) scanCursors.clear();
        if (!claimable.length) return 0;
        const due = await tx.execute<{ id: string }>(sql`
        SELECT id FROM journey_participants
        WHERE status IN ('ready', 'waiting') AND due_at <= ${now()}
          AND id IN (${sql.join(
            claimable.map((id) => sql`${Number(id)}`),
            sql`, `,
          )})
        ORDER BY due_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED`);
        if (!due.rows.length) return 0;
        const list = await tx
          .select()
          .from(schema.journeyParticipants)
          .where(
            inArray(
              schema.journeyParticipants.id,
              due.rows.map((r) => Number(r.id)),
            ),
          );
        const segments = await publishedSegments(tx);
        const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
        for (const p of list) {
          // The row can sit on an id a merge folded away (a participant the hook inserted before
          // #1011). The trait step follows the `merged_into` chain itself; the other reads stay on the
          // stored id, which a merge moves along with the person.
          const t = now();
          // Someone who refused the journey's purpose leaves before the next step (#108). Consent
          // changes exit them at once (exitRefusedJourneys); this catches whatever got past that.
          const purpose = await graphOf(tx, p.journeyId, p.version)
            .then((g) => g.purpose)
            .catch(() => null);
          if (purpose && refusedPurposes(await consentStateOf(tx, ws, p.profileId), purposes).includes(purpose)) {
            const detail = `consent_withdrawn: ${purpose}`;
            await tx
              .update(schema.journeyParticipants)
              .set({ status: 'exited', error: detail, dueAt: null, waitingEvent: null, waitingUntil: null, updatedAt: t })
              .where(eq(schema.journeyParticipants.id, p.id));
            journeyEvents.push({
              workspaceId: ws,
              journeyId: p.journeyId,
              version: p.version,
              participantId: p.id,
              profileId: p.profileId,
              node: p.node,
              type: 'exited',
              seq: p.seq + 1,
              at: t.toISOString(),
              detail,
            });
            continue;
          }
          const state: ParticipantState = {
            node: p.node,
            status: p.status,
            seq: p.seq,
            dueAt: p.dueAt,
            waitingEvent: p.waitingEvent,
            waitingUntil: p.waitingUntil,
            matched: p.matched,
            converted: p.converted,
          };
          // One savepoint per participant: a PostgreSQL error inside a read, the advance or an effect
          // aborts the transaction (25P02), and the retry state could not be written afterwards. The
          // savepoint lets this participant's partial work be discarded while the round carries on.
          const savepoint = `participant_${p.id}`;
          const eventMark = journeyEvents.length;
          await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
          let graph: Graph | undefined;
          try {
            graph = await graphOf(tx, p.journeyId, p.version);
            const result = await advance(graph, state, t, {
              key: String(p.id),
              result: (node) => {
                const r = (p.context.results as Record<string, { seq: number; ok: boolean; error?: string }> | undefined)?.[node];
                return r && r.seq === p.seq ? r : undefined;
              },
              ai: (node) => {
                const r = (p.context.ai as Record<string, AiOutcome & { seq: number }> | undefined)?.[node];
                return r && r.seq === p.seq ? r : undefined;
              },
              branch: async (n) => {
                if (n.segment) {
                  const [m] = await tx
                    .select()
                    .from(schema.segmentMemberships)
                    .where(and(eq(schema.segmentMemberships.segmentId, n.segment), eq(schema.segmentMemberships.profileId, p.profileId)));
                  return !!m;
                }
                const ids = await evaluate(n.condition!, contextFor(tx, ws, deps.events, segments, { scope: [p.profileId] }));
                return ids.has(p.profileId);
              },
              condition: async (n) => matchesCondition(tx, ws, deps.events, segments, p.profileId, n.condition),
            });
            const details = new Map<string, string>();
            const held = (p.context as { holdout?: { arm?: string } }).holdout;
            const flags = { wakeNow: false, control: held?.arm === 'control' };
            for (const eff of result.effects) {
              const d = await applyEffect(tx, ws, p, eff, deps, graph, flags);
              if (d !== null) details.set(`${eff.node}:${eff.seq}`, d);
            }
            await tx
              .update(schema.journeyParticipants)
              .set({ ...result.state, attempts: 0, error: null, ...(flags.wakeNow ? { dueAt: t } : {}), updatedAt: t })
              .where(eq(schema.journeyParticipants.id, p.id));
            if (p.seq === 0)
              journeyEvents.push({
                workspaceId: ws,
                journeyId: p.journeyId,
                version: p.version,
                participantId: p.id,
                profileId: p.profileId,
                node: p.node,
                type: 'entered',
                seq: 0,
                at: p.enteredAt.toISOString(),
                detail: '',
              });
            for (const s of result.steps)
              journeyEvents.push({
                workspaceId: ws,
                journeyId: p.journeyId,
                version: p.version,
                participantId: p.id,
                profileId: p.profileId,
                node: s.node,
                type: s.type,
                seq: s.seq,
                at: t.toISOString(),
                detail: details.get(`${s.node}:${s.seq}`) ?? s.detail,
              });
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
          } catch (err) {
            // Discard everything this participant wrote before the failure, including an effect that
            // may have run, and then record the retry in a healthy transaction.
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
            journeyEvents.length = eventMark;
            const failedAt = now();
            const error = journeyErrorText(err);
            // The wait (goal/waitEvent) had already resolved when advance ran, but its outcome died
            // with the savepoint. Persist which way it went before the retry: an event that arrives
            // during the backoff must not turn a timed-out goal into a conversion. The deadline is
            // in waitingUntil, which the backoff below does not overwrite.
            const waitingNode = graph?.nodes.get(p.node);
            const waitOutcome =
              p.status === 'waiting' && (waitingNode?.kind === 'goal' || waitingNode?.kind === 'waitEvent')
                ? { matched: p.matched, waitingEvent: null }
                : {};
            // A broken condition (an AppError('invalid_input'): an unknown purpose, a personal-data
            // trait, a segment loop) is permanent. Anything else is a transient store or database
            // failure: leave the participant where it is, due after a backoff, and fail it only when
            // the retry budget is spent (#1240, docs/architecture/journeys-and-editors.md:63).
            const attempts = p.attempts + 1;
            const broken = err instanceof AppError && err.code === 'invalid_input';
            if (broken || attempts >= MAX_ADVANCE_ATTEMPTS) {
              await tx
                .update(schema.journeyParticipants)
                .set({ status: 'failed', error, attempts, dueAt: null, waitingUntil: null, updatedAt: failedAt })
                .where(eq(schema.journeyParticipants.id, p.id));
              journeyEvents.push({
                workspaceId: ws,
                journeyId: p.journeyId,
                version: p.version,
                participantId: p.id,
                profileId: p.profileId,
                node: p.node,
                type: 'failed',
                seq: p.seq + 1,
                at: failedAt.toISOString(),
                detail: error,
              });
            } else {
              await tx
                .update(schema.journeyParticipants)
                .set({
                  attempts,
                  error,
                  // The backoff runs from the failure, not from the timestamp taken before a slow read.
                  dueAt: new Date(failedAt.getTime() + advanceRetryDelayMs(attempts)),
                  updatedAt: failedAt,
                  ...waitOutcome,
                })
                .where(eq(schema.journeyParticipants.id, p.id));
            }
          }
        }
        // Same transaction as the participant rows: a committed step and its events are one unit
        // (#1244). Nothing here does network I/O; the dispatcher publishes afterwards.
        await enqueueJourneyEvents(tx, ws, journeyEvents);
        return list.length;
      });
    } catch (err) {
      logger.error({ err, workspace: ws }, 'journey sweep workspace failed');
    }
  }
  return moved;
}

export async function runSweeper(db: Db, deps: JourneyDeps, signal: AbortSignal) {
  while (!signal.aborted) {
    let moved = 0;
    try {
      moved = await sweep(db, deps);
    } catch (err) {
      logger.error({ err }, 'journey sweep failed');
    }
    if (!moved) await sleep(250, signal);
  }
}
