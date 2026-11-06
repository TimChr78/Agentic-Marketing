import { appendAuditEntry, defineCommand } from '@agentic-marketing/commands';
import { AppError, hashValue, isoDateTime } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requestPublish, updateDraft } from './commands';
import { type AgentMandate, artifactTypes } from './types';

// Mandate renewal at scale (#428): list the mandates that lapse soon (or already lapsed while their
// agent is still active), and renew several in one call. A renewal is the existing single path —
// a new version with a later validUntil, published by the person — with one audit entry per
// mandate so the decision stays attributable even when one of several fails.

const MandateId = z.string().regex(/^mnd_[0-9a-f]{32}$/, 'A mandate id looks like mnd_…');

export const listMandateRenewals = defineCommand({
  name: 'agents.renewals',
  title: 'Mandates to renew',
  description:
    'Published mandates whose agent is still active and whose validUntil is within `withinDays` (default 30), plus expired mandates still attached to an active agent. Newest expiry first, with the agent, version and how many days are left (negative when expired). Renew one or several with agents.renewMandates.',
  input: z.object({ withinDays: z.number().int().min(0).max(365).default(30) }),
  output: z.object({
    withinDays: z.number().int(),
    renewals: z.array(
      z.object({
        mandateId: z.string(),
        name: z.string(),
        agentId: z.string(),
        agentName: z.string(),
        agentStatus: z.string(),
        version: z.number().int(),
        validUntil: z.string(),
        expired: z.boolean(),
        daysLeft: z.number().int().describe('Whole days until validUntil; negative once expired'),
      }),
    ),
  }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const now = new Date();
    const horizon = new Date(now.getTime() + input.withinDays * 86_400_000);
    const rows = await ctx.tx
      .select({
        mandateId: schema.artifacts.id,
        name: schema.artifacts.name,
        version: schema.artifacts.publishedVersion,
        content: schema.artifactVersions.content,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        agentStatus: schema.agents.status,
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
      .innerJoin(
        schema.agents,
        and(
          eq(schema.agents.workspaceId, schema.artifacts.workspaceId),
          sql`${schema.artifactVersions.content}->>'agent' = ${schema.agents.id}`,
        ),
      )
      .where(
        and(
          eq(schema.artifacts.type, 'agent_mandate'),
          eq(schema.artifacts.archived, false),
          isNotNull(schema.artifacts.publishedVersion),
          eq(schema.agents.status, 'active'),
        ),
      );
    const renewals = rows
      .flatMap((r) => {
        const parsed = artifactTypes.agent_mandate.content.safeParse(r.content);
        if (!parsed.success) return [];
        const until = new Date(parsed.data.validUntil);
        if (until > horizon) return [];
        const left = (until.getTime() - now.getTime()) / 86_400_000;
        return [
          {
            mandateId: r.mandateId,
            name: r.name,
            agentId: r.agentId,
            agentName: r.agentName,
            agentStatus: r.agentStatus,
            version: r.version!,
            validUntil: until.toISOString(),
            expired: until <= now,
            // Expired rows are at least one day overdue, so "expired" and a negative number agree.
            daysLeft: until <= now ? -Math.max(1, Math.ceil(-left)) : Math.ceil(left),
          },
        ];
      })
      // Newest expiry first, as the description promises.
      .sort((a, b) => b.validUntil.localeCompare(a.validUntil));
    return { withinDays: input.withinDays, renewals };
  },
});

const Renewed = z.object({
  mandateId: z.string(),
  ok: z.boolean(),
  status: z.enum(['published', 'in_review', 'on_hold']).nullable(),
  version: z.number().int().nullable(),
  validUntil: z.string().nullable(),
  error: z.string().nullable(),
});

export const renewMandates = defineCommand({
  name: 'agents.renewMandates',
  title: 'Renew mandates',
  description:
    'Renew several mandates at once: for each id, publish a new version of the mandate with the new validUntil and the same levels, scope and limits, with one note. People only. Each mandate is renewed in its own savepoint, so one failure does not undo the others; the result says what happened per id and the audit log has one entry per mandate.',
  input: z.object({
    mandateIds: z.array(MandateId).min(1).max(50).describe('Mandates to renew, from agents.renewals'),
    validUntil: isoDateTime('validUntil')
      .refine((v) => new Date(v).getTime() > Date.now(), 'validUntil must be in the future')
      .refine((v) => new Date(v).getTime() <= Date.now() + 366 * 86_400_000, 'validUntil must be at most a year away')
      .describe('The new end date; must be in the future and at most a year away'),
    note: z.string().min(1).max(1000).describe('Why the mandates are renewed; kept on every new version and in the audit log'),
  }),
  output: z.object({ renewed: z.array(Renewed) }),
  permission: 'artifacts:publish',
  effect: 'publish',
  humansOnly: true,
  actionClass: 'content.publish',
  // One entry per mandate, written by the handler; the executor would otherwise add one for the call.
  auditsItself: true,
  target: (i) => i.mandateIds.join(','),
  handler: async (input, ctx) => {
    const renewed: z.output<typeof Renewed>[] = [];
    const mandateIds = [...new Set(input.mandateIds)];
    // Lock the whole set before writing anything, in one deterministic order (#455). A renewal
    // takes the workspace audit lock (transaction-scoped) while it publishes and then moves to the
    // next mandate; two bulk calls in opposite order, or an edit that holds a mandate and waits for
    // the audit lock, would otherwise form a cycle. Processing stays in the caller's order so the
    // per-id result and audit entries read the same as the input.
    await ctx.tx
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), inArray(schema.artifacts.id, mandateIds)))
      .orderBy(schema.artifacts.id)
      .for('update');
    for (const [index, mandateId] of mandateIds.entries()) {
      const inputHash = hashValue({ mandateId, validUntil: input.validUntil, note: input.note });
      // A savepoint per mandate: one failure rolls back only its own version and audit entry.
      const savepoint = `renew_mandate_${index}`;
      await ctx.tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        const [artifact] = await ctx.tx
          .select({
            id: schema.artifacts.id,
            type: schema.artifacts.type,
            publishedVersion: schema.artifacts.publishedVersion,
            latestVersion: schema.artifacts.latestVersion,
          })
          .from(schema.artifacts)
          .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, mandateId)))
          // The published version, hash and draft write are one decision (#455): a concurrent
          // renewal or edit waits here instead of reading the same version and overwriting it.
          .for('update');
        if (!artifact) throw new AppError('not_found', `Mandate ${mandateId} was not found in this workspace.`);
        if (artifact.type !== 'agent_mandate') throw new AppError('invalid_input', `${mandateId} is a ${artifact.type}, not a mandate.`);
        if (artifact.publishedVersion === null) throw new AppError('conflict', `Mandate ${mandateId} has no published version to renew.`);
        // A renewal changes only validUntil. Anything newer than the published version is someone's
        // unreviewed work; refuse it rather than replace it with the older published terms (#455).
        if (artifact.latestVersion !== artifact.publishedVersion)
          throw new AppError(
            'conflict',
            `Mandate ${mandateId} has an unpublished version (v${artifact.latestVersion}). Publish or discard it before renewing, so the renewal does not overwrite it.`,
          );
        const [version] = await ctx.tx
          .select({ content: schema.artifactVersions.content, contentHash: schema.artifactVersions.contentHash })
          .from(schema.artifactVersions)
          .where(
            and(
              eq(schema.artifactVersions.workspaceId, ctx.principal.workspaceId),
              eq(schema.artifactVersions.artifactId, mandateId),
              eq(schema.artifactVersions.number, artifact.publishedVersion),
            ),
          );
        const parsed = artifactTypes.agent_mandate.content.safeParse(version?.content);
        if (!parsed.success)
          throw new AppError('conflict', `Mandate ${mandateId}'s published version cannot be read, so it cannot be renewed.`);
        const content: AgentMandate = { ...parsed.data, validUntil: new Date(input.validUntil).toISOString() };
        const draft = await updateDraft.handler(
          {
            artifactId: mandateId,
            content,
            note: `Renewed: ${input.note}`.slice(0, 500),
            // The published version's hash: a draft created by someone else meanwhile fails instead of being replaced.
            expectedContentHash: version.contentHash,
          },
          ctx,
        );
        const out = await requestPublish.handler({ artifactId: mandateId, note: `Renewal: ${input.note}`.slice(0, 1000) }, ctx);
        await appendAuditEntry(
          ctx.tx,
          ctx.principal,
          ctx.surface ?? 'internal',
          { name: 'agents.renewMandates', effect: 'publish' },
          inputHash,
          mandateId,
        );
        await ctx.tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
        renewed.push({
          mandateId,
          ok: true,
          status: out.status,
          version: out.version ?? draft.version,
          validUntil: content.validUntil,
          error: null,
        });
      } catch (err) {
        // Undo this mandate's version and success entry, keep the rest of the call.
        await ctx.tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`)).catch(() => {});
        const error = err instanceof AppError ? err : new AppError('conflict', err instanceof Error ? err.message : String(err));
        renewed.push({
          mandateId,
          ok: false,
          status: null,
          version: null,
          validUntil: null,
          error: error.message,
        });
        await appendAuditEntry(
          ctx.tx,
          ctx.principal,
          ctx.surface ?? 'internal',
          { name: 'agents.renewMandates', effect: 'publish' },
          inputHash,
          mandateId,
          error,
        );
      }
    }
    return { renewed };
  },
});

export const mandateRenewalCommands = [listMandateRenewals, renewMandates] as const;
