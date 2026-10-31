import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type LearningEvidence, schema } from '@agentic-marketing/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

// Learnings (agentic-autonomy §6, #311): a small, inspectable store of conclusions with the
// experiments that back them ("subject lines with a number win for this audience: 3 of 4 tests,
// +2.1 pts"). People and agents write them; agents read the active ones as the MCP resource
// learnings://current. This is not a memory dump: a learning needs evidence, and an agent's
// evidence must point at a real broadcast, journey, campaign or experience in this workspace.

const LearningId = z
  .string()
  .regex(/^lrn_[0-9a-f]{32}$/, 'A learning id looks like "lrn_…"')
  .describe('Learning id, e.g. "lrn_0192…"');

const EvidenceKind = z.enum(['subject_test', 'journey_holdout', 'campaign_holdout', 'experience']);

/** The artifact type each kind of result comes from. */
const EVIDENCE_TYPE = {
  subject_test: 'broadcast',
  journey_holdout: 'journey',
  campaign_holdout: 'campaign',
  experience: 'experience',
} as const satisfies Record<z.infer<typeof EvidenceKind>, string>;

const Evidence = z.object({
  kind: EvidenceKind.describe(
    'subject_test: a broadcast subject test; journey_holdout or campaign_holdout: its measured control group; experience: an experience analysis',
  ),
  id: z.string().min(1).max(80).describe('Id of the broadcast (bct_…), journey (jrn_…), campaign (cmp_…) or experience (exp_…)'),
  summary: z.string().min(1).max(1000).describe('What the result showed, in one sentence'),
  numbers: z.record(z.string(), z.number()).default({}).describe('The measured numbers, e.g. {"wins":3,"tests":4,"liftPts":2.1}'),
});

const Scope = z.object({
  segmentIds: z.array(z.string()).max(50).optional().describe('Audience segment ids the learning applies to'),
  channel: z.string().max(40).optional().describe('Channel, e.g. "email"'),
  topic: z.string().max(80).optional().describe('Topic under a purpose'),
  purpose: z.string().max(80).optional().describe('Purpose key'),
});

const Learning = z.object({
  id: z.string(),
  statement: z.string(),
  scope: Scope,
  evidence: z.array(Evidence),
  author: z.object({ type: z.enum(['user', 'agent']), id: z.string() }),
  agentId: z.string().nullable().describe('The agent that wrote it, or null for a person'),
  status: z.enum(['active', 'retracted']),
  retractedBy: z.string().nullable(),
  retractedAt: z.string().nullable(),
  retractReason: z.string().nullable(),
  createdAt: z.string(),
});

type LearningRow = typeof schema.learnings.$inferSelect;

function toLearning(row: LearningRow) {
  return {
    id: row.id,
    statement: row.statement,
    scope: row.scope,
    evidence: row.evidence,
    author: { type: row.authorType, id: row.authorId },
    agentId: row.agentId,
    status: row.status,
    retractedBy: row.retractedBy,
    retractedAt: row.retractedAt?.toISOString() ?? null,
    retractReason: row.retractReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** An agent's evidence must name a result that exists here: no learning from a remembered id. */
async function assertAgentEvidence(ctx: CommandContext, evidence: LearningEvidence[]) {
  const rows = await ctx.tx
    .select({ id: schema.artifacts.id, type: schema.artifacts.type })
    .from(schema.artifacts)
    .where(
      inArray(
        schema.artifacts.id,
        evidence.map((item) => item.id),
      ),
    );
  for (const [i, item] of evidence.entries()) {
    const row = rows.find((r) => r.id === item.id);
    if (!row)
      throw new AppError(
        'invalid_input',
        `evidence[${i}] (${item.kind}): ${item.id} is not an artifact in this workspace. Reference the broadcast, journey, campaign or experience the result came from.`,
      );
    const expected = EVIDENCE_TYPE[item.kind];
    if (row.type !== expected)
      throw new AppError('invalid_input', `evidence[${i}] (${item.kind}) must reference a ${expected}, but ${item.id} is a ${row.type}.`);
  }
}

/** The active learnings, with the scope filters an agent uses to find the ones that apply. */
export const listLearnings = defineCommand({
  name: 'learnings.list',
  title: 'List learnings',
  description:
    'Conclusions with their evidence, newest first. By default only active ones; filter by status, audience segment, channel, topic and purpose. People and agents read this; the MCP resource learnings://current serves the active ones.',
  input: z.object({
    status: z.enum(['active', 'retracted', 'all']).default('active').describe('active (default), retracted, or all'),
    segmentId: z.string().optional().describe('Only learnings whose scope names this audience segment id'),
    channel: z.string().optional().describe('Only learnings for this channel, e.g. "email"'),
    topic: z.string().optional().describe('Only learnings for this topic'),
    purpose: z.string().optional().describe('Only learnings for this purpose'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ learnings: z.array(Learning), count: z.number().int() }),
  permission: 'artifacts:read',
  effect: 'read',
  actionClass: 'read',
  handler: async (input, ctx) => {
    const conditions = [
      input.status === 'all' ? undefined : eq(schema.learnings.status, input.status),
      input.segmentId ? sql`${schema.learnings.scope}->'segmentIds' @> ${JSON.stringify([input.segmentId])}::jsonb` : undefined,
      input.channel ? sql`${schema.learnings.scope}->>'channel' = ${input.channel}` : undefined,
      input.topic ? sql`${schema.learnings.scope}->>'topic' = ${input.topic}` : undefined,
      input.purpose ? sql`${schema.learnings.scope}->>'purpose' = ${input.purpose}` : undefined,
    ];
    const rows = await ctx.tx
      .select()
      .from(schema.learnings)
      .where(and(...conditions))
      .orderBy(desc(schema.learnings.createdAt))
      .limit(input.limit);
    return { learnings: rows.map(toLearning), count: rows.length };
  },
});

/** Record a conclusion with the result that backs it. Agents add drafts, never live changes. */
export const addLearning = defineCommand({
  name: 'learnings.add',
  title: 'Add a learning',
  description:
    'Record a conclusion and the experiment or holdout that supports it, with the scope it applies to. People and agents may add one; an agent’s evidence must reference a broadcast, journey, campaign or experience in this workspace. Draft-level: it never needs autonomy and a person can retract it.',
  input: z.object({
    statement: z.string().min(1).max(2000).describe('The conclusion, e.g. "Subject lines with a number win for this audience"'),
    scope: Scope.default({}).describe('Where it applies: audience segment ids, channel, topic and purpose (all optional)'),
    evidence: z
      .array(Evidence)
      .min(1)
      .max(20)
      .describe('The results behind it: a broadcast subject test, a journey or campaign holdout, or an experience'),
  }),
  output: Learning,
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    if (ctx.principal.type === 'agent') await assertAgentEvidence(ctx, input.evidence);
    const row = {
      workspaceId: ctx.principal.workspaceId,
      id: newId('lrn'),
      statement: input.statement,
      scope: input.scope,
      evidence: input.evidence,
      authorType: ctx.principal.type,
      authorId: ctx.principal.userId,
      agentId: ctx.principal.agent?.id ?? null,
    };
    const [created] = await ctx.tx.insert(schema.learnings).values(row).returning();
    return toLearning(created);
  },
});

/** People retract a learning that no longer holds; the row and its reason stay for the record. */
export const retractLearning = defineCommand({
  name: 'learnings.retract',
  title: 'Retract a learning',
  description:
    'Retract a learning that no longer holds, with the reason. People only: an agent may add evidence but never withdraw someone else’s conclusion. The learning stays in the record with status retracted and is no longer served as current.',
  input: z.object({
    id: LearningId,
    reason: z.string().min(1).max(1000).describe('Why it no longer holds, e.g. "the effect did not repeat in the next four tests"'),
  }),
  output: Learning,
  permission: 'artifacts:write',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const [existing] = await ctx.tx
      .select()
      .from(schema.learnings)
      .where(and(eq(schema.learnings.workspaceId, ctx.principal.workspaceId), eq(schema.learnings.id, input.id)));
    if (!existing) throw new AppError('not_found', `No learning ${input.id} in this workspace.`);
    if (existing.status === 'retracted')
      throw new AppError(
        'conflict',
        `Learning ${input.id} is already retracted${existing.retractReason ? `: ${existing.retractReason}` : '.'}`,
      );
    const [updated] = await ctx.tx
      .update(schema.learnings)
      .set({ status: 'retracted', retractedBy: ctx.principal.userId, retractedAt: new Date(), retractReason: input.reason })
      .where(and(eq(schema.learnings.workspaceId, ctx.principal.workspaceId), eq(schema.learnings.id, input.id)))
      .returning();
    return toLearning(updated);
  },
});

export const learningsCommands = [listLearnings, addLearning, retractLearning] as const;
