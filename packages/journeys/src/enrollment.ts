import { artifactTypes, type JourneyDefinition } from '@agentic-marketing/artifacts';
import { campaignWithControlForMember } from '@agentic-marketing/campaigns';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { checkPushRecipient, checkRecipient, checkSmsRecipient } from '@agentic-marketing/email';
import type { EventStore, JourneyEvent } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { compile, type Graph } from './graph';
import { assignHoldout, holdoutDetail } from './holdout';
import { journeyTouchesOf } from './impact';

// Bulk enrollment (#148): a deliberate backfill of a segment into a journey, in chunks, with a
// resumable cursor and a visible job. Per person the same gates as journeys.enroll apply (re-entry,
// an existing profile, consent and suppression for the journey's first channel), plus a deterministic
// entry key so a retried chunk can never enroll someone twice.

/** People scanned per tick. Small enough that a crash loses at most one chunk of work. */
export const ENROLLMENT_CHUNK_SIZE = 500;

/** Jobs processed per scheduler tick. */
const MAX_JOBS_PER_RUN = 100;

export const enrollmentJobStatus = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type EnrollmentJobStatus = z.infer<typeof enrollmentJobStatus>;

export interface EnrollmentDeps {
  db: Db;
  kp: KeyProvider;
  events?: Pick<EventStore, 'insertJourneyEvents'>;
}

export interface EnrollmentSummary {
  /** Jobs that made progress. */
  jobs: number;
  entered: number;
  skipped: number;
  failed: number;
  /** Jobs that finished in this run. */
  done: number;
}

const emptySummary = (): EnrollmentSummary => ({ jobs: 0, entered: 0, skipped: 0, failed: 0, done: 0 });

type JobRow = typeof schema.enrollmentJobs.$inferSelect;

export const enrollmentJobOutput = z.object({
  jobId: z.string(),
  journeyId: z.string(),
  segmentId: z.string(),
  status: enrollmentJobStatus,
  people: z.number().int().describe('People in the segment when the job was requested, capped by limit'),
  limit: z.number().int().nullable().describe('How many members the job may try; null means the whole segment'),
  cursor: z.string().nullable().describe('The last profile id scanned; the job resumes after it'),
  entered: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  skipReasons: z.record(z.string(), z.number().int()).describe('Why people were skipped: a reason code → people'),
  requestedBy: z.object({ type: z.enum(['user', 'agent']), id: z.string() }),
  reason: z.string(),
  idempotencyKey: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

/** A job as the commands report it (dates as ISO strings). */
export function enrollmentJobOut(job: JobRow) {
  return {
    jobId: job.id,
    journeyId: job.journeyId,
    segmentId: job.segmentId,
    status: job.status,
    people: job.people,
    limit: job.limit,
    cursor: job.cursor,
    entered: job.entered,
    skipped: job.skipped,
    failed: job.failed,
    skipReasons: job.skipReasons,
    requestedBy: { type: job.requestedByType, id: job.requestedById },
    reason: job.reason,
    idempotencyKey: job.idempotencyKey,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** People currently in a segment, capped by `limit`; the impact estimate and the job's audience. */
export async function countSegmentMembers(tx: Tx, segmentId: string, limit?: number | null): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.segmentMemberships)
    .innerJoin(
      schema.profiles,
      and(
        eq(schema.profiles.workspaceId, schema.segmentMemberships.workspaceId),
        eq(schema.profiles.id, schema.segmentMemberships.profileId),
        isNull(schema.profiles.mergedInto),
      ),
    )
    .where(eq(schema.segmentMemberships.segmentId, segmentId));
  return limit ? Math.min(n, limit) : n;
}

/** A reason code for the skip summary, e.g. `no_lawful_basis: purpose …` → `no_lawful_basis`. */
function reasonCode(reason: string): string {
  const code = (reason.split(':')[0] ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_');
  return code || 'ineligible';
}

interface PublishedJourney {
  version: number;
  def: JourneyDefinition;
  graph: Graph;
}

async function publishedJourney(tx: Tx, journeyId: string): Promise<PublishedJourney | null> {
  const [a] = await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, journeyId));
  if (a?.type !== 'journey' || !a.publishedVersion) return null;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, journeyId), eq(schema.artifactVersions.number, a.publishedVersion)));
  if (!v) return null;
  const def = artifactTypes.journey.content.parse(v.content) as JourneyDefinition;
  return { version: a.publishedVersion, def, graph: compile(def) };
}

/**
 * The channel whose consent and suppression gate entry. A journey with several channels is gated
 * on the first it uses (e-mail, then SMS, then push); a journey with none has nothing to gate.
 */
function entryChannel(def: JourneyDefinition): 'email' | 'sms' | 'push' | null {
  const channels = journeyTouchesOf(def).touches.channels;
  return ['email', 'sms', 'push'].find((c): c is 'email' | 'sms' | 'push' => channels.includes(c)) ?? null;
}

/** The consent, address and suppression verdict for one person on the journey's entry channel. */
async function entryVerdict(
  deps: EnrollmentDeps,
  tx: Tx,
  workspaceId: string,
  channel: 'email' | 'sms' | 'push',
  profileId: string,
  purpose: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const check = channel === 'email' ? checkRecipient : channel === 'sms' ? checkSmsRecipient : checkPushRecipient;
  const verdict = await check(tx, workspaceId, deps.kp, profileId, purpose);
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
}

interface ChunkResult {
  summary: EnrollmentSummary;
  holdout: JourneyEvent[];
}

/** One chunk of one job, in the caller's transaction. Null when another process holds the job. */
async function processChunk(deps: EnrollmentDeps, tx: Tx, workspaceId: string, jobId: string): Promise<ChunkResult | null> {
  // Two scheduler pods must not scan the same chunk: the second skips a locked job.
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT id FROM enrollment_jobs
    WHERE id = ${jobId} AND status IN ('queued', 'running')
    FOR UPDATE SKIP LOCKED`);
  if (!locked.rows.length) return null;
  const [job] = await tx.select().from(schema.enrollmentJobs).where(eq(schema.enrollmentJobs.id, jobId));
  if (!job) return null;

  const now = new Date();
  const finish = async (status: EnrollmentJobStatus, extra: Partial<JobRow> = {}) => {
    await tx
      .update(schema.enrollmentJobs)
      .set({ status, updatedAt: now, ...(status === 'done' || status === 'failed' ? { finishedAt: now } : {}), ...extra })
      .where(eq(schema.enrollmentJobs.id, job.id));
  };

  const journey = await publishedJourney(tx, job.journeyId);
  if (!journey) {
    await finish('failed', { error: `Journey ${job.journeyId} has no published version.` });
    return { summary: emptySummary(), holdout: [] };
  }

  const processed = job.entered + job.skipped + job.failed;
  const remaining = job.limit === null ? ENROLLMENT_CHUNK_SIZE : Math.max(0, job.limit - processed);
  if (remaining === 0) {
    await finish('done');
    return { summary: { ...emptySummary(), done: 1 }, holdout: [] };
  }
  const chunkSize = Math.min(ENROLLMENT_CHUNK_SIZE, remaining);

  const page = await tx.execute<{ profile_id: string }>(sql`
    SELECT profile_id FROM segment_memberships
    WHERE segment_id = ${job.segmentId}
      ${job.cursor ? sql`AND profile_id > ${job.cursor}` : sql``}
    ORDER BY profile_id
    LIMIT ${chunkSize}`);
  const ids = page.rows.map((r) => r.profile_id);
  if (!ids.length) {
    await finish('done');
    return { summary: { ...emptySummary(), done: 1 }, holdout: [] };
  }

  // Profiles that still exist (not merged into someone else) can enter; the rest are reported.
  const existing = new Set(
    (
      await tx
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(and(inArray(schema.profiles.id, ids), isNull(schema.profiles.mergedInto)))
    ).map((r) => r.id),
  );
  // Re-entry: one query for the chunk, with the same rule journeys.enroll uses.
  const blocked = new Set<string>();
  if (journey.graph.trigger.reentry !== 'always') {
    const prior = await tx
      .select({ profileId: schema.journeyParticipants.profileId, status: schema.journeyParticipants.status })
      .from(schema.journeyParticipants)
      .where(
        and(
          eq(schema.journeyParticipants.journeyId, job.journeyId),
          inArray(schema.journeyParticipants.profileId, ids),
          journey.graph.trigger.reentry === 'after_exit' ? inArray(schema.journeyParticipants.status, ['ready', 'waiting']) : undefined,
        ),
      );
    for (const p of prior) blocked.add(p.profileId);
  }

  const channel = entryChannel(journey.def);
  const campaign = await campaignWithControlForMember(tx, job.journeyId);
  const reasons = { ...job.skipReasons };
  const skip = (code: string) => {
    reasons[code] = (reasons[code] ?? 0) + 1;
  };
  let entered = 0;
  let skipped = 0;
  let failed = 0;
  const holdout: JourneyEvent[] = [];

  for (const profileId of ids) {
    if (!existing.has(profileId)) {
      skipped++;
      skip('no_profile');
      continue;
    }
    if (blocked.has(profileId)) {
      skipped++;
      skip('reentry');
      continue;
    }
    if (channel) {
      const verdict = await entryVerdict(deps, tx, workspaceId, channel, profileId, journey.graph.purpose);
      if (!verdict.ok) {
        skipped++;
        skip(reasonCode(verdict.reason));
        continue;
      }
    }
    try {
      const assigned = campaign
        ? await assignHoldout(tx, workspaceId, { type: 'campaign', id: campaign.id }, campaign.content.controlGroup, profileId)
        : await assignHoldout(tx, workspaceId, { type: 'journey', id: job.journeyId }, journey.graph.controlGroup, profileId);
      const [participant] = await tx
        .insert(schema.journeyParticipants)
        .values({
          workspaceId,
          journeyId: job.journeyId,
          version: journey.version,
          profileId,
          // Deterministic: a retried chunk cannot create a second participant for the same person.
          entryKey: `bulk:${job.id}:${profileId}`,
          node: journey.graph.start,
          status: 'ready',
          dueAt: now,
          context: {
            event: {
              name: 'manual',
              properties: { reason: job.reason, enrollmentJob: job.id, segment: job.segmentId },
            },
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
      if (!participant) {
        skipped++;
        skip('duplicate');
        continue;
      }
      entered++;
      if (assigned?.created)
        holdout.push({
          workspaceId,
          journeyId: campaign?.id ?? job.journeyId,
          version: campaign?.version ?? journey.version,
          participantId: participant.id,
          profileId,
          node: journey.graph.start,
          type: 'holdout_assigned',
          seq: 0,
          at: now.toISOString(),
          detail: holdoutDetail(assigned.assignment, campaign?.id),
        });
    } catch (err) {
      failed++;
      skip('error');
      logger.warn({ err, job: job.id, profileId }, 'bulk enrollment skipped a person after an error');
    }
  }

  const last = ids[ids.length - 1];
  const done = ids.length < chunkSize || processed + ids.length >= (job.limit ?? Number.POSITIVE_INFINITY);
  await finish(done ? 'done' : 'running', {
    ...(job.status === 'queued' ? { startedAt: now } : {}),
    cursor: last,
    entered: job.entered + entered,
    skipped: job.skipped + skipped,
    failed: job.failed + failed,
    skipReasons: reasons,
  });
  return { summary: { jobs: 1, entered, skipped, failed, done: done ? 1 : 0 }, holdout };
}

/**
 * One scheduler sweep: every unfinished job scans one chunk (or finishes). Each chunk commits its
 * participants and its cursor together, so a crash resumes after the last scanned person.
 */
export async function runEnrollmentJobsOnce(deps: EnrollmentDeps): Promise<EnrollmentSummary> {
  const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
    `SELECT workspace_id, id FROM enrollment_jobs
     WHERE status IN ('queued', 'running')
     ORDER BY created_at
     LIMIT ${MAX_JOBS_PER_RUN}`,
  );
  const total = emptySummary();
  for (const { workspace_id: workspaceId, id } of rows) {
    try {
      const result = await deps.db.withWorkspace(workspaceId, (tx) => processChunk(deps, tx, workspaceId, id));
      if (!result) continue;
      total.jobs += result.summary.jobs;
      total.entered += result.summary.entered;
      total.skipped += result.summary.skipped;
      total.failed += result.summary.failed;
      total.done += result.summary.done;
      if (deps.events && result.holdout.length) await deps.events.insertJourneyEvents(result.holdout).catch(() => {});
    } catch (err) {
      logger.error({ err, workspaceId, job: id }, 'enrollment job chunk failed');
      const message = err instanceof Error ? err.message : String(err);
      await deps.db
        .withWorkspace(workspaceId, (tx) =>
          tx
            .update(schema.enrollmentJobs)
            .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(schema.enrollmentJobs.id, id), inArray(schema.enrollmentJobs.status, ['queued', 'running']))),
        )
        .catch(() => {});
    }
  }
  return total;
}

export interface EnrollmentOptions {
  tickMs?: number;
}

/** The scheduler job: one chunk per unfinished job every few seconds by default. */
export async function runEnrollmentJobs(deps: EnrollmentDeps, signal: AbortSignal, opts: EnrollmentOptions = {}) {
  const tickMs = opts.tickMs ?? 5_000;
  logger.info('scheduler role: segment enrollment jobs');
  while (!signal.aborted) {
    try {
      await runEnrollmentJobsOnce(deps);
    } catch (err) {
      logger.error({ err }, 'enrollment job round failed');
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
