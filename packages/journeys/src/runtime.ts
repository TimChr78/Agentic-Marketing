import { artifactTypes, type JourneyDefinition, publishedSingleton } from '@agentic-marketing/artifacts';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { requestEmail } from '@agentic-marketing/email';
import type { EventStore, JourneyEvent } from '@agentic-marketing/events';
import type { ResolvedEvent } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { contextFor, ENTERED, evaluate, publishedSegments } from '@agentic-marketing/segments';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { compile, type Graph } from './graph';
import { advance, type Effect, type ParticipantState, type Step } from './interpreter';

// The journey runtime (ADR-0004): trigger matching and wake-ups run as a post-commit hook of the
// profile workers; the sweeper (worker role) advances due participants in batches.

export interface JourneyDeps {
  kp: KeyProvider;
  events: EventStore;
}

const graphs = new Map<string, Graph>();

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

/** Enters people into journeys whose trigger the events match, and wakes those waiting for them. */
export async function matchEvents(tx: Tx, workspaceId: string, resolved: ResolvedEvent[]): Promise<{ entered: number; woken: number }> {
  if (!resolved.length) return { entered: 0, woken: 0 };
  const journeys = await publishedJourneys(tx);
  let entered = 0;
  let woken = 0;
  for (const { event: e, profileId } of resolved) {
    for (const j of journeys) {
      const t = j.graph.trigger;
      const hit = t.event ? t.event === e.name && e.name !== ENTERED : e.name === ENTERED && e.properties.segment_id === t.segment;
      if (!hit) continue;
      if (t.reentry !== 'always') {
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
      const res = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId,
          journeyId: j.id,
          version: j.version,
          profileId,
          entryKey: e.messageId,
          node: j.graph.start,
          status: 'ready',
          dueAt: new Date(),
          context: { event: { name: e.name, properties: e.properties } },
        })
        .onConflictDoNothing()
        .returning({ id: schema.journeyParticipants.id });
      entered += res.length;
    }
    // Wake whoever waits for this event (wait-for-event and goal nodes).
    const w = await tx.execute(sql`
      UPDATE journey_participants SET matched = true, waiting_event = NULL, due_at = now(), updated_at = now()
      WHERE workspace_id = ${workspaceId} AND profile_id = ${profileId} AND waiting_event = ${e.name} AND status = 'waiting'`);
    woken += w.rowCount ?? 0;
  }
  return { entered, woken };
}

/** The after-resolve hook for the profile workers. */
export function journeyHook(db: Db) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    await db.withWorkspace(workspaceId, (tx) => matchEvents(tx, workspaceId, resolved));
  };
}

async function applyEffect(tx: Tx, workspaceId: string, p: typeof schema.journeyParticipants.$inferSelect, eff: Effect, deps: JourneyDeps) {
  if (eff.kind === 'email') {
    const d = await requestEmail(tx, workspaceId, deps.kp, deps.events, {
      profileId: p.profileId,
      templateId: eff.template,
      idempotencyKey: `jrn:${p.id}:${eff.node}:${eff.seq}`,
      journeyId: p.journeyId,
      data: p.context,
    });
    return `e-mail ${d.status}${d.reason ? `: ${d.reason}` : ''}`;
  }
  // Only non-personal traits; personal data never comes from a journey definition.
  const plan = await publishedSingleton(tx, 'tracking_plan');
  const def = plan?.traits.find((x) => x.name === eff.trait);
  if (def && def.pii !== 'none') return `skipped: ${eff.trait} is personal data`;
  await tx.execute(sql`
    UPDATE profiles SET traits = jsonb_set(traits, ARRAY[${eff.trait}], ${JSON.stringify(eff.value)}::jsonb), updated_at = now()
    WHERE workspace_id = ${workspaceId} AND id = ${p.profileId}`);
  return `${eff.trait} = ${JSON.stringify(eff.value)}`;
}

/**
 * One sweep: per workspace, claim due participants, advance them, apply effects and write
 * states in one transaction. Returns how many participants moved.
 */
export async function sweep(db: Db, deps: JourneyDeps, opts: { batch?: number; now?: () => Date } = {}): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM journey_participants WHERE status IN ('ready', 'waiting') AND due_at <= $1 LIMIT 100`,
    [now()],
  );
  let moved = 0;
  for (const { workspace_id: ws } of rows) {
    const journeyEvents: JourneyEvent[] = [];
    moved += await db.withWorkspace(ws, async (tx) => {
      const due = await tx.execute<{ id: string }>(sql`
        SELECT id FROM journey_participants
        WHERE status IN ('ready', 'waiting') AND due_at <= ${now()}
        ORDER BY due_at LIMIT ${opts.batch ?? 200} FOR UPDATE SKIP LOCKED`);
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
      for (const p of list) {
        const t = now();
        const state: ParticipantState = {
          node: p.node,
          status: p.status,
          seq: p.seq,
          dueAt: p.dueAt,
          waitingEvent: p.waitingEvent,
          matched: p.matched,
          converted: p.converted,
        };
        let result: { state: ParticipantState; effects: Effect[]; steps: Step[] };
        try {
          const graph = await graphOf(tx, p.journeyId, p.version);
          result = await advance(graph, state, t, {
            key: String(p.id),
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
          });
        } catch (err) {
          const error = (err as Error).message;
          await tx
            .update(schema.journeyParticipants)
            .set({ status: 'failed', error, dueAt: null, updatedAt: t })
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
            at: t.toISOString(),
            detail: error,
          });
          continue;
        }
        const details = new Map<string, string>();
        for (const eff of result.effects) details.set(`${eff.node}:${eff.seq}`, await applyEffect(tx, ws, p, eff, deps));
        await tx
          .update(schema.journeyParticipants)
          .set({ ...result.state, updatedAt: t })
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
      }
      return list.length;
    });
    await deps.events.insertJourneyEvents(journeyEvents).catch((err) => logger.warn({ err }, 'journey events not stored'));
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
    if (!moved) await new Promise((r) => setTimeout(r, 250));
  }
}
