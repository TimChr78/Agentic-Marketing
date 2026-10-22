import { artifactTypes, type BroadcastDefinition, publishValidators } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { checkRecipient, checkSmsRecipient, requestEmail, requestSms } from '@agentic-marketing/email';
import type { EventStore } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';

// Broadcasts: a one-off send of a template to a segment, e.g. the weekly newsletter. Publishing
// the artifact (after approval, when the workspace's policy wants one) schedules a run; the
// scheduler works through the segment's members and asks the send gateway for each, so consent,
// suppressions and unsubscribes apply per person. Sends are keyed by (broadcast, person). A
// broadcast sends once: publishing a later version after its run changes nothing.

const BroadcastId = z.string().regex(/^bct_[0-9a-f]{32}$/);
const BATCH = 200;
const LEASE_MS = 120_000;

async function published(tx: Tx, id: string, type: 'email_template' | 'sms_template' | 'segment') {
  const [a] = await tx
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.type, type), isNotNull(schema.artifacts.publishedVersion)));
  return !!a;
}

publishValidators.set('broadcast', async (content, tx: Tx) => {
  const b = content as BroadcastDefinition;
  const problems: string[] = [];
  const sms = b.template.startsWith('sms_');
  if (!(await published(tx, b.template, sms ? 'sms_template' : 'email_template')))
    problems.push(`${b.template} is not a published ${sms ? 'SMS' : 'e-mail'} template`);
  if (!(await published(tx, b.segment, 'segment'))) problems.push(`${b.segment} is not a published segment`);
  return problems;
});

async function definition(tx: Tx, id: string, version?: number) {
  const [a] = await tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.type, 'broadcast')));
  if (!a) throw new AppError('not_found', `No broadcast ${id}.`);
  const number = version ?? a.publishedVersion ?? a.latestVersion;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, id), eq(schema.artifactVersions.number, number)));
  return { artifact: a, version: number, def: artifactTypes.broadcast.content.parse(v.content) as BroadcastDefinition };
}

async function purposeOf(tx: Tx, templateId: string) {
  const [row] = await tx
    .select({ purpose: sql<string>`${schema.artifactVersions.content} ->> 'purpose'` })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.id, templateId));
  return row?.purpose ?? null;
}

export const previewBroadcast = defineCommand({
  name: 'broadcasts.preview',
  title: 'Preview a broadcast’s audience',
  description:
    'Who a broadcast (default: its latest version) would reach right now: the segment size and, for up to 2,000 members, how many the send gateway would send to and why it would skip the others (no consent, suppressed, no address). Sends nothing.',
  input: z.object({ artifactId: BroadcastId, version: z.number().int().min(1).optional() }),
  output: z.object({
    audience: z.number(),
    checked: z.number(),
    wouldSend: z.number(),
    wouldSkip: z.record(z.string(), z.number()).describe('Reason → people'),
    sendAt: z.string().nullable(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const { def } = await definition(ctx.tx, input.artifactId, input.version);
    const purpose = await purposeOf(ctx.tx, def.template);
    if (!purpose) throw new AppError('conflict', `${def.template} has no published version yet.`);
    const [{ n }] = await ctx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.segmentMemberships)
      .where(eq(schema.segmentMemberships.segmentId, def.segment));
    const members = await ctx.tx
      .select({ profileId: schema.segmentMemberships.profileId })
      .from(schema.segmentMemberships)
      .where(eq(schema.segmentMemberships.segmentId, def.segment))
      .limit(2000);
    let wouldSend = 0;
    const wouldSkip: Record<string, number> = {};
    for (const m of members) {
      const v = await (def.template.startsWith('sms_') ? checkSmsRecipient : checkRecipient)(
        ctx.tx,
        ctx.principal.workspaceId,
        ctx.services.keyProvider,
        m.profileId,
        purpose,
      );
      if (v.ok) wouldSend++;
      else {
        const reason = v.reason.split(':')[0];
        wouldSkip[reason] = (wouldSkip[reason] ?? 0) + 1;
      }
    }
    return { audience: n, checked: members.length, wouldSend, wouldSkip, sendAt: def.sendAt ?? null };
  },
});

const Run = z.object({
  status: z.enum(['not_scheduled', 'scheduled', 'running', 'done', 'cancelled', 'failed']),
  version: z.number().nullable(),
  sendAt: z.string().nullable(),
  recipients: z.number(),
  queued: z.number(),
  skipped: z.number(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const broadcastStatus = defineCommand({
  name: 'broadcasts.status',
  title: 'Broadcast status and results',
  description:
    'Where a broadcast is (scheduled, running, done, cancelled) with how many people it reached and skipped, and what became of the e-mails: sent, delivered, bounced, complained, clicked, unsubscribed.',
  input: z.object({ artifactId: BroadcastId }),
  output: z.object({ run: Run, messages: z.record(z.string(), z.number()) }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    await definition(ctx.tx, input.artifactId);
    const [r] = await ctx.tx.select().from(schema.broadcastRuns).where(eq(schema.broadcastRuns.broadcastId, input.artifactId));
    const messages = r
      ? await ctx.services.events.messageStats(ctx.principal.workspaceId, { since: r.createdAt, journeyId: input.artifactId })
      : {};
    return {
      run: {
        status: r?.status ?? 'not_scheduled',
        version: r?.version ?? null,
        sendAt: r?.sendAt.toISOString() ?? null,
        recipients: r?.recipients ?? 0,
        queued: r?.queued ?? 0,
        skipped: r?.skipped ?? 0,
        startedAt: r?.startedAt?.toISOString() ?? null,
        finishedAt: r?.finishedAt?.toISOString() ?? null,
        error: r?.error ?? null,
      },
      messages,
    };
  },
});

export const cancelBroadcast = defineCommand({
  name: 'broadcasts.cancel',
  title: 'Cancel a broadcast',
  description: 'Stop a scheduled or running broadcast. People already sent to keep their e-mail; nobody else gets it. Cannot be undone.',
  input: z.object({ artifactId: BroadcastId }),
  output: z.object({ status: z.literal('cancelled'), queued: z.number() }),
  permission: 'messages:send',
  effect: 'write',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const { artifact, version, def } = await definition(ctx.tx, input.artifactId);
    const [r] = await ctx.tx
      .select()
      .from(schema.broadcastRuns)
      .where(eq(schema.broadcastRuns.broadcastId, input.artifactId))
      .for('update');
    if (r && !['scheduled', 'running'].includes(r.status)) throw new AppError('conflict', `The broadcast is already ${r.status}.`);
    if (r)
      await ctx.tx
        .update(schema.broadcastRuns)
        .set({ status: 'cancelled', finishedAt: new Date(), leaseUntil: null })
        .where(eq(schema.broadcastRuns.broadcastId, input.artifactId));
    else
      await ctx.tx.insert(schema.broadcastRuns).values({
        workspaceId: ctx.principal.workspaceId,
        broadcastId: artifact.id,
        version,
        status: 'cancelled',
        sendAt: def.sendAt ? new Date(def.sendAt) : new Date(),
        finishedAt: new Date(),
      });
    return { status: 'cancelled' as const, queued: r?.queued ?? 0 };
  },
});

export const broadcastCommands = [previewBroadcast, broadcastStatus, cancelBroadcast] as const;

export interface BroadcastDeps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
}

/** Schedules runs for newly published broadcasts. */
async function schedule(db: Db) {
  const { rows } = await db.admin.query<{ workspace_id: string; id: string; version: number; content: BroadcastDefinition }>(
    `SELECT a.workspace_id, a.id, a.published_version AS version, v.content FROM artifacts a
     JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
     LEFT JOIN broadcast_runs r ON r.workspace_id = a.workspace_id AND r.broadcast_id = a.id
     WHERE a.type = 'broadcast' AND a.published_version IS NOT NULL AND a.archived = false AND r.broadcast_id IS NULL LIMIT 100`,
  );
  for (const r of rows)
    await db.withWorkspace(r.workspace_id, (tx) =>
      tx
        .insert(schema.broadcastRuns)
        .values({
          workspaceId: r.workspace_id,
          broadcastId: r.id,
          version: r.version,
          status: 'scheduled',
          sendAt: r.content.sendAt ? new Date(r.content.sendAt) : new Date(),
        })
        .onConflictDoNothing(),
    );
}

/** Sends one batch of a due run. Returns whether the run has more to do. */
async function sendBatch(db: Db, ws: string, broadcastId: string, deps: BroadcastDeps): Promise<boolean> {
  return db.withWorkspace(ws, async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.broadcastRuns)
      .where(and(eq(schema.broadcastRuns.broadcastId, broadcastId), inArray(schema.broadcastRuns.status, ['scheduled', 'running'])))
      .for('update', { skipLocked: true });
    if (!run) return false;
    const { def } = await definition(tx, broadcastId, run.version);
    const members = await tx
      .select({ profileId: schema.segmentMemberships.profileId })
      .from(schema.segmentMemberships)
      .where(and(eq(schema.segmentMemberships.segmentId, def.segment), gt(schema.segmentMemberships.profileId, run.cursor)))
      .orderBy(asc(schema.segmentMemberships.profileId))
      .limit(BATCH);
    let queued = 0;
    for (const m of members) {
      const d = await (def.template.startsWith('sms_') ? requestSms : requestEmail)(tx, ws, deps.kp, deps.events, {
        profileId: m.profileId,
        templateId: def.template,
        idempotencyKey: `bct:${broadcastId}:${m.profileId}`,
        // Messages record the journey or broadcast that sent them.
        journeyId: broadcastId,
      });
      if (d.status === 'queued') queued++;
    }
    const finished = members.length < BATCH;
    await tx
      .update(schema.broadcastRuns)
      .set({
        status: finished ? 'done' : 'running',
        cursor: members.at(-1)?.profileId ?? run.cursor,
        recipients: run.recipients + members.length,
        queued: run.queued + queued,
        skipped: run.skipped + members.length - queued,
        startedAt: run.startedAt ?? new Date(),
        finishedAt: finished ? new Date() : null,
        leaseUntil: finished ? null : new Date(Date.now() + LEASE_MS),
      })
      .where(eq(schema.broadcastRuns.broadcastId, broadcastId));
    return !finished;
  });
}

/** One scheduler tick: schedule new broadcasts, then work through the due ones. */
export async function runBroadcastsOnce(deps: BroadcastDeps) {
  await schedule(deps.db);
  const { rows } = await deps.db.admin.query<{ workspace_id: string; broadcast_id: string }>(
    `SELECT workspace_id, broadcast_id FROM broadcast_runs
     WHERE send_at <= now() AND (status = 'scheduled' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now()))) LIMIT 20`,
  );
  for (const r of rows) {
    try {
      while (await sendBatch(deps.db, r.workspace_id, r.broadcast_id, deps));
    } catch (err) {
      logger.error({ err, broadcast: r.broadcast_id }, 'broadcast batch failed; it resumes on the next tick');
    }
  }
}

export async function runBroadcasts(deps: BroadcastDeps, signal: AbortSignal, tickMs = 5000) {
  while (!signal.aborted) {
    await runBroadcastsOnce(deps).catch((err) => logger.error({ err }, 'broadcast tick failed'));
    await new Promise<void>((r) => {
      const timer = setTimeout(r, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
}
