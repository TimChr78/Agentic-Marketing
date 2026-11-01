import {
  type ActionClass,
  AutonomySettings,
  autonomySettings,
  type CommandContext,
  defineCommand,
  isUndoable,
  type Principal,
  runUndo,
  undoBlocker,
} from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type AgentCredentialKind, type AgentStatus, type AgentUndo, type Db, schema, type Tx } from '@agentic-marketing/db';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

// Agents as first-class principals (ADR-0016, #213). An API token or an OAuth client acts as an
// agent; the agent is created the first time the credential is used, with the person who created
// or connected it as sponsor. Pausing an agent stops all of its credentials at once.

type AgentRef = NonNullable<Principal['agent']>;

const AGENT_ID = z.string().regex(/^agt_[0-9a-f]{32}$/, 'An agent id looks like agt_…');

/**
 * The agent behind a credential, created on first use. Runs on the admin pool, like the token
 * lookup it follows: the workspace is not known before the credential is resolved.
 */
export async function agentForCredential(
  db: Db,
  workspaceId: string,
  kind: AgentCredentialKind,
  credentialId: string,
  sponsorUserId: string,
  defaultName: () => Promise<string>,
): Promise<AgentRef> {
  const find = async () => {
    const { rows } = await db.admin.query<{
      id: string;
      name: string;
      status: AgentStatus;
      status_reason: string | null;
      sponsor_user_id: string;
    }>(
      `SELECT a.id, a.name, a.status, a.status_reason, a.sponsor_user_id
       FROM agent_credentials c JOIN agents a ON a.workspace_id = c.workspace_id AND a.id = c.agent_id
       WHERE c.workspace_id = $1 AND c.kind = $2 AND c.credential_id = $3`,
      [workspaceId, kind, credentialId],
    );
    return rows[0];
  };
  let row = await find();
  if (!row) {
    const id = newId('agt');
    const name = (await defaultName()).slice(0, 120);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      // Two first requests at once: the credential's primary key lets one attach; the other reuses it.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent:${workspaceId}:${kind}:${credentialId}`]);
      const again = await client.query('SELECT 1 FROM agent_credentials WHERE workspace_id = $1 AND kind = $2 AND credential_id = $3', [
        workspaceId,
        kind,
        credentialId,
      ]);
      if (!again.rowCount) {
        await client.query('INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, $3, $4)', [
          workspaceId,
          id,
          name,
          sponsorUserId,
        ]);
        await client.query('INSERT INTO agent_credentials (workspace_id, kind, credential_id, agent_id) VALUES ($1, $2, $3, $4)', [
          workspaceId,
          kind,
          credentialId,
          id,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    row = await find();
    if (!row) throw new Error(`agent for ${kind} ${credentialId} was not created`);
  }
  return { id: row.id, name: row.name, status: row.status, statusReason: row.status_reason };
}

/** The display name of an OAuth client, from Better Auth's client table; a generic name if it cannot be read. */
export async function oauthClientName(db: Db, clientId: string): Promise<string> {
  try {
    const { rows } = await db.admin.query<{ name: string | null }>('SELECT name FROM "oauthClient" WHERE "clientId" = $1', [clientId]);
    if (rows[0]?.name) return rows[0].name;
  } catch {
    // The table name is Better Auth's; fall through to the generic name.
  }
  return `MCP client ${clientId.slice(0, 8)}`;
}

// --- Commands -----------------------------------------------------------------------------------

const Credential = z.object({ kind: z.enum(['api_token', 'oauth_client', 'hosted']), id: z.string(), since: z.string() });
const Agent = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  sponsor: z.object({ id: z.string(), name: z.string() }),
  status: z.enum(['active', 'paused', 'revoked']),
  statusReason: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  brand: z.string().nullable().describe('Reserved for multi-brand: null means the whole workspace'),
  credentials: z.array(Credential),
  guard: z
    .object({
      cap: z.number().int(),
      irreversibleCap: z.number().int().optional(),
      reason: z.string(),
      since: z.string(),
      episodeIds: z.array(z.string()),
    })
    .nullable()
    .describe('The guardian’s cap on this agent until a person clears it (agents.clearGuard); null when it has not acted'),
  last24h: z.object({
    changes: z.number().int(),
    denied: z.number().int(),
    escalated: z.number().int().describe('Sent to a person (ask)'),
    held: z.number().int().describe('Held for a veto window (level 2)'),
  }),
  createdAt: z.string(),
});
type Agent = z.infer<typeof Agent>;

async function loadAgents(ctx: CommandContext, ids?: string[]): Promise<Agent[]> {
  const { tx } = ctx;
  const rows = await tx
    .select()
    .from(schema.agents)
    .where(ids ? inArray(schema.agents.id, ids) : undefined)
    .orderBy(desc(schema.agents.createdAt));
  if (!rows.length) return [];
  const agentIds = rows.map((r) => r.id);
  const creds = await tx.select().from(schema.agentCredentials).where(inArray(schema.agentCredentials.agentId, agentIds));
  const counts = await tx
    .select({
      agentId: schema.agentActions.agentId,
      changes: sql<number>`count(*) FILTER (WHERE ${schema.agentActions.decision} = 'allow' AND ${schema.agentActions.ok} AND ${schema.agentActions.actionClass} <> 'draft')::int`,
      denied: sql<number>`count(*) FILTER (WHERE ${schema.agentActions.decision} = 'deny')::int`,
      escalated: sql<number>`count(*) FILTER (WHERE ${schema.agentActions.decision} = 'ask')::int`,
      held: sql<number>`count(*) FILTER (WHERE ${schema.agentActions.decision} = 'hold')::int`,
    })
    .from(schema.agentActions)
    .where(and(inArray(schema.agentActions.agentId, agentIds), sql`${schema.agentActions.at} > now() - interval '24 hours'`))
    .groupBy(schema.agentActions.agentId);
  const sponsors = await ctx.services.directory.users([...new Set(rows.map((r) => r.sponsorUserId))]);
  const people = new Map([...sponsors].map(([id, p]) => [id, p.name || p.email || id]));
  return rows.map((r) => {
    const c = counts.find((x) => x.agentId === r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      sponsor: { id: r.sponsorUserId, name: people.get(r.sponsorUserId) ?? r.sponsorUserId },
      status: r.status,
      statusReason: r.statusReason,
      statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
      brand: r.brand,
      credentials: creds
        .filter((x) => x.agentId === r.id)
        .map((x) => ({ kind: x.kind, id: x.credentialId, since: x.createdAt.toISOString() })),
      guard: r.guard ?? null,
      last24h: { changes: c?.changes ?? 0, denied: c?.denied ?? 0, escalated: c?.escalated ?? 0, held: c?.held ?? 0 },
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export const listAgents = defineCommand({
  name: 'agents.list',
  title: 'List agents',
  description:
    'Every agent in the workspace: API tokens and connected MCP clients each act as an agent, with a sponsor (the person accountable), a status (active, paused, revoked), its credentials and what it did in the last 24 hours. An agent sees the list too, so it can find its own id.',
  input: z.object({}),
  output: z.object({ agents: z.array(Agent) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => ({ agents: await loadAgents(ctx) }),
});

export const getAgent = defineCommand({
  name: 'agents.get',
  title: 'Get an agent',
  description: 'One agent with its sponsor, status, credentials and counts for the last 24 hours. Omit the id to get the calling agent.',
  input: z.object({ id: AGENT_ID.optional() }),
  output: Agent,
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const id = input.id ?? ctx.principal.agent?.id;
    if (!id) throw new AppError('invalid_input', 'Pass the agent id; only an agent can omit it to get itself.');
    const [a] = await loadAgents(ctx, [id]);
    if (!a) throw new AppError('not_found', `Agent ${id} not found.`);
    return a;
  },
});

export const updateAgent = defineCommand({
  name: 'agents.update',
  title: 'Rename or re-sponsor an agent',
  description:
    'Change an agent’s name, description or sponsor. The sponsor must be a member of the workspace; the agent never has more permissions than its sponsor’s role.',
  input: z.object({
    id: AGENT_ID,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    sponsorUserId: z.string().optional().describe('A workspace member who becomes accountable for the agent'),
  }),
  output: Agent,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    if (input.sponsorUserId) {
      const [m] = await ctx.tx.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, input.sponsorUserId));
      if (!m) throw new AppError('invalid_input', 'The sponsor must be a member of this workspace.');
    }
    const updated = await ctx.tx
      .update(schema.agents)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.sponsorUserId ? { sponsorUserId: input.sponsorUserId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.agents.id, input.id))
      .returning({ id: schema.agents.id });
    if (!updated.length) throw new AppError('not_found', `Agent ${input.id} not found.`);
    return (await loadAgents(ctx, [input.id]))[0];
  },
});

const setStatus = <N extends 'agents.pause' | 'agents.resume' | 'agents.revoke'>(name: N, status: AgentStatus) =>
  defineCommand({
    name,
    title: { 'agents.pause': 'Pause an agent', 'agents.resume': 'Resume an agent', 'agents.revoke': 'Revoke an agent' }[name],
    description: {
      'agents.pause':
        'Stop an agent at once: every credential it holds (API tokens, MCP clients) is refused from the next request, and its pending approvals cannot be approved until it is resumed. Resumable.',
      'agents.resume': 'Let a paused agent work again, with the same credentials and limits.',
      'agents.revoke':
        'End an agent for good: its credentials stop working and it cannot be resumed. Its history and the content it created stay.',
    }[name],
    input: z.object({ id: AGENT_ID, reason: z.string().max(500).optional().describe('Shown to the agent and in the activity') }),
    output: Agent,
    permission: 'workspace:admin',
    effect: 'write',
    humansOnly: true,
    target: (i) => i.id,
    handler: async (input, ctx) => {
      const [a] = await ctx.tx.select().from(schema.agents).where(eq(schema.agents.id, input.id));
      if (!a) throw new AppError('not_found', `Agent ${input.id} not found.`);
      if (a.status === 'revoked') throw new AppError('conflict', 'This agent is revoked and cannot change status.');
      await ctx.tx
        .update(schema.agents)
        .set({
          status,
          statusReason: status === 'active' ? null : (input.reason ?? null),
          statusChangedBy: ctx.principal.userId,
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agents.id, input.id));
      return (await loadAgents(ctx, [input.id]))[0];
    },
  });

export const pauseAgent = setStatus('agents.pause', 'paused');
export const resumeAgent = setStatus('agents.resume', 'active');
export const revokeAgent = setStatus('agents.revoke', 'revoked');

const Action = z.object({
  id: z.number().int(),
  agentId: z.string(),
  command: z.string(),
  actionClass: z.string(),
  decision: z
    .enum(['allow', 'hold', 'ask', 'deny'])
    .describe('allow: ran; hold: waited for a veto window (level 2); ask: waited for a person; deny: refused'),
  mandateId: z.string().nullable().describe('The mandate that decided, if any'),
  mandateVersion: z.number().int().nullable(),
  intent: z.string().nullable().describe('What the agent said it was doing'),
  shadow: z
    .object({
      decision: z.enum(['allow', 'hold', 'ask', 'deny']),
      level: z.number().int().optional(),
      reasons: z.array(z.string()),
      mandateId: z.string(),
      mandateVersion: z.number().int(),
    })
    .nullable()
    .describe('Shadow mode: what the mandate would have decided; `decision` is what applied'),
  reasons: z.array(z.string()),
  impact: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  error: z.string().nullable(),
  target: z.string().nullable(),
  surface: z.string(),
  at: z.string(),
  undo: z.unknown().nullable().describe('How to reverse it, when the action published something (null when there is nothing to undo)'),
  undoable: z.boolean().describe('Whether agents.undo can reverse this action now'),
  undoBlockedBy: z
    .string()
    .nullable()
    .describe('Why an action that recorded a reversal cannot be undone now (newer work went live, or the send went out)'),
  undoneAt: z.string().nullable(),
  undoneBy: z.string().nullable(),
  undoResult: z.string().nullable().describe('What the undo did'),
});

export const agentActivity = defineCommand({
  name: 'agents.activity',
  title: 'Agent activity',
  description:
    'The action ledger: every agent write with the policy decision (allow, ask = waited for a person, deny = refused) and its reasons, the impact estimate (e.g. people reached) and whether it succeeded. Newest first; page with `before`.',
  input: z.object({
    agentId: AGENT_ID.optional(),
    decision: z.enum(['allow', 'hold', 'ask', 'deny']).optional(),
    actionClass: z.string().optional(),
    since: z.string().datetime().optional(),
    before: z.number().int().optional().describe('Return entries with a smaller id (the last id of the previous page)'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ actions: z.array(Action), next: z.number().int().nullable() }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const t = schema.agentActions;
    const rows = await ctx.tx
      .select()
      .from(t)
      .where(
        and(
          input.agentId ? eq(t.agentId, input.agentId) : undefined,
          input.decision ? eq(t.decision, input.decision) : undefined,
          input.actionClass ? eq(t.actionClass, input.actionClass) : undefined,
          input.since ? gte(t.at, new Date(input.since)) : undefined,
          input.before ? lt(t.id, input.before) : undefined,
        ),
      )
      .orderBy(desc(t.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    // What the ledger offers is checked against the current state, as agents.undo would (#305).
    const actions = [];
    for (const r of page) {
      const recorded = isUndoable(r);
      const blocker = recorded && r.undo ? await undoBlocker(ctx.tx, r.undo as AgentUndo) : null;
      actions.push({
        ...r,
        at: r.at.toISOString(),
        impact: r.impact ?? {},
        undoable: recorded && !blocker,
        undoBlockedBy: blocker,
        undoneAt: r.undoneAt?.toISOString() ?? null,
      });
    }
    return {
      actions,
      next: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});

// --- The guardian (#253) -----------------------------------------------------------------------

const Episode = z.object({
  id: z.string(),
  kind: z.enum(['guardrail', 'anomaly', 'probing', 'loop', 'errors']),
  action: z
    .enum(['cap', 'hold', 'pause'])
    .describe('cap: every change waits for a person; hold: irreversible actions are held; pause: the agent was paused'),
  reason: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  suspendedHolds: z.number().int().describe('Pending holds of the agent that became ordinary approvals'),
  at: z.string(),
  clearedAt: z.string().nullable(),
  clearedBy: z.string().nullable(),
  clearedNote: z.string().nullable(),
});

const episodeOut = (e: typeof schema.guardianEvents.$inferSelect) => ({
  ...e,
  at: e.at.toISOString(),
  clearedAt: e.clearedAt?.toISOString() ?? null,
});

export const agentGuardian = defineCommand({
  name: 'agents.guardian',
  title: 'Guardian episodes',
  description:
    'What the guardian did to an agent: each episode (a guardrail breach, an anomaly such as a send far larger than usual or a burst of changes, probing = many refusals, a loop = the same target changed again and again, rising errors) with its evidence and action, and the cap still in force. Newest first.',
  input: z.object({
    agentId: AGENT_ID,
    open: z.boolean().default(false).describe('Only episodes no person has cleared yet'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ guard: Agent.shape.guard, episodes: z.array(Episode) }),
  permission: 'audit:read',
  effect: 'read',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx.select({ guard: schema.agents.guard }).from(schema.agents).where(eq(schema.agents.id, input.agentId));
    if (!a) throw new AppError('not_found', `Agent ${input.agentId} not found.`);
    const g = schema.guardianEvents;
    const rows = await ctx.tx
      .select()
      .from(g)
      .where(and(eq(g.agentId, input.agentId), input.open ? isNull(g.clearedAt) : undefined))
      .orderBy(desc(g.at))
      .limit(input.limit);
    return { guard: a.guard ?? null, episodes: rows.map(episodeOut) };
  },
});

export const clearGuard = defineCommand({
  name: 'agents.clearGuard',
  title: 'Clear the guardian',
  description:
    'Lift the guardian’s cap on an agent after reviewing its episodes: every open episode is marked cleared with your note and the agent’s mandate applies again. A paused agent stays paused until agents.resume; held changes the guardian suspended stay with a person.',
  input: z.object({ agentId: AGENT_ID, note: z.string().min(1).max(1000).describe('What you checked and why it is safe to continue') }),
  output: z.object({ cleared: z.number().int(), agent: Agent }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const [a] = await ctx.tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, input.agentId));
    if (!a) throw new AppError('not_found', `Agent ${input.agentId} not found.`);
    const now = new Date();
    const cleared = await ctx.tx
      .update(schema.guardianEvents)
      .set({ clearedAt: now, clearedBy: ctx.principal.userId, clearedNote: input.note })
      .where(and(eq(schema.guardianEvents.agentId, input.agentId), isNull(schema.guardianEvents.clearedAt)))
      .returning({ id: schema.guardianEvents.id });
    await ctx.tx.update(schema.agents).set({ guard: null, updatedAt: now }).where(eq(schema.agents.id, input.agentId));
    return { cleared: cleared.length, agent: (await loadAgents(ctx, [input.agentId]))[0] };
  },
});

// --- Shadow mode (#256) -------------------------------------------------------------------------

const Agreement = z.enum(['agree', 'too_bold', 'too_cautious', 'pending', 'unreviewed']);
const TALLY = { agree: 'agree', too_bold: 'tooBold', too_cautious: 'tooCautious', pending: 'pending', unreviewed: 'unreviewed' } as const;

export const shadowReport = defineCommand({
  name: 'agents.shadowReport',
  title: 'Shadow mode report',
  description:
    'For a mandate in shadow mode: what the agent would have done (its mandate’s decision) next to what people did with the same changes. agree: the mandate would have let it run and a person approved, or would have asked and a person rejected; too_bold: it would have run (or been held) but a person rejected it; too_cautious: it would have asked but a person approved; pending: no decision yet; unreviewed: no person reviewed it (the approval policy let it run). Use it to decide whether to grant the level for real.',
  input: z.object({
    agentId: AGENT_ID,
    since: z.string().datetime().optional().describe('Default: 30 days ago'),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({
    summary: z.object({
      total: z.number().int(),
      agree: z.number().int(),
      tooBold: z.number().int(),
      tooCautious: z.number().int(),
      pending: z.number().int(),
      unreviewed: z.number().int(),
      agreementRate: z.number().nullable().describe('agree ÷ (agree + too_bold + too_cautious); null without reviewed changes'),
    }),
    byClass: z.record(
      z.string(),
      z.object({ total: z.number().int(), agree: z.number().int(), tooBold: z.number().int(), tooCautious: z.number().int() }),
    ),
    actions: z.array(
      z.object({
        id: z.number().int(),
        at: z.string(),
        command: z.string(),
        actionClass: z.string(),
        target: z.string().nullable(),
        wouldHave: z.enum(['allow', 'hold', 'ask', 'deny']),
        wouldHaveLevel: z.number().int().nullable(),
        decision: z.enum(['allow', 'hold', 'ask', 'deny']),
        review: z.enum(['approved', 'rejected', 'withdrawn', 'pending', 'none']),
        agreement: Agreement,
      }),
    ),
  }),
  permission: 'audit:read',
  effect: 'read',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const t = schema.agentActions;
    const since = input.since ? new Date(input.since) : new Date(Date.now() - 30 * 86_400_000);
    const rows = await ctx.tx
      .select()
      .from(t)
      .where(and(eq(t.agentId, input.agentId), isNotNull(t.shadow), gte(t.at, since)))
      .orderBy(desc(t.id))
      .limit(input.limit);
    const summary = { total: 0, agree: 0, tooBold: 0, tooCautious: 0, pending: 0, unreviewed: 0 };
    const byClass: Record<string, { total: number; agree: number; tooBold: number; tooCautious: number }> = {};
    const actions = [];
    for (const r of rows) {
      const shadow = r.shadow!;
      // The approval this action created: the first request for its target(s) at or after it.
      let review: 'approved' | 'rejected' | 'withdrawn' | 'pending' | 'none' = 'none';
      // The approval the action itself created, recorded with it (#286); none means nobody reviewed it.
      const approvalId = typeof r.impact?.approvalId === 'string' ? r.impact.approvalId : null;
      if (approvalId) {
        const [ap] = await ctx.tx
          .select({ status: schema.approvalRequests.status })
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.id, approvalId));
        if (ap) review = ap.status;
      }
      const wouldRun = shadow.decision === 'allow' || shadow.decision === 'hold';
      const agreement: z.infer<typeof Agreement> =
        review === 'none'
          ? 'unreviewed'
          : review === 'pending'
            ? 'pending'
            : review === 'approved'
              ? wouldRun
                ? 'agree'
                : 'too_cautious'
              : wouldRun
                ? 'too_bold'
                : 'agree';
      const key = TALLY[agreement];
      summary.total++;
      summary[key]++;
      const c = byClass[r.actionClass] ?? { total: 0, agree: 0, tooBold: 0, tooCautious: 0 };
      byClass[r.actionClass] = c;
      c.total++;
      if (key === 'agree' || key === 'tooBold' || key === 'tooCautious') c[key]++;
      actions.push({
        id: r.id,
        at: r.at.toISOString(),
        command: r.command,
        actionClass: r.actionClass,
        target: r.target,
        wouldHave: shadow.decision,
        wouldHaveLevel: shadow.level ?? null,
        decision: r.decision,
        review,
        agreement,
      });
    }
    const reviewed = summary.agree + summary.tooBold + summary.tooCautious;
    return { summary: { ...summary, agreementRate: reviewed ? summary.agree / reviewed : null }, byClass, actions };
  },
});

// --- Undo (#255) --------------------------------------------------------------------------------

/**
 * Reverses one agent action in the caller's transaction (ADR-0016 §5.4), returns what happened and
 * marks the ledger row undone. `by` names the person (or later the guardian) who did it. Exported
 * so the guardian can roll back an agent's action the same way a person does.
 */
export async function undoAgentAction(tx: Tx, ctx: CommandContext, actionId: number, by: string, note?: string) {
  const [action] = await tx.select().from(schema.agentActions).where(eq(schema.agentActions.id, actionId)).for('update');
  if (!action) throw new AppError('not_found', `Agent action ${actionId} was not found in this workspace.`);
  if (action.undoneAt)
    throw new AppError(
      'conflict',
      `This action was already undone on ${action.undoneAt.toISOString()}${action.undoneBy ? ` by ${action.undoneBy}` : ''}. It cannot be undone twice.`,
    );
  if (!action.ok || action.decision === 'deny')
    throw new AppError('conflict', `${action.command} did not happen, so there is nothing to undo.`);
  if (action.decision === 'ask' || action.decision === 'hold')
    throw new AppError(
      'conflict',
      `${action.command} waited for a person and never ran by itself, so there is nothing to undo. Use approvals.reject to withdraw it.`,
    );
  const undo = action.undo as AgentUndo | null;
  if (!undo) throw new AppError('conflict', `${action.command} changed nothing that can be undone.`);
  if (undo.kind === 'none') throw new AppError('conflict', undo.reason);
  const steps = await runUndo({ ...ctx, tx }, undo);
  const result = [steps.join(' '), note ? `Note: ${note}` : ''].filter(Boolean).join(' ').slice(0, 2000);
  const undoneAt = new Date();
  await tx.update(schema.agentActions).set({ undoneAt, undoneBy: by, undoResult: result }).where(eq(schema.agentActions.id, actionId));
  return { actionId, undoneAt: undoneAt.toISOString(), result, steps };
}

export const undoAgent = defineCommand({
  name: 'agents.undo',
  title: 'Undo an agent action',
  description:
    'Reverse something an agent did: republish the version it replaced (or unpublish what it first published), and cancel a broadcast that has not gone out yet. Only people can undo. A message that was already sent cannot be recalled; the ledger says so, and this command explains it.',
  input: z.object({
    actionId: z.number().int().describe('The ledger entry, from agents.activity'),
    note: z.string().max(1000).optional().describe('Why it is being undone, kept with the ledger entry'),
  }),
  output: z.object({
    actionId: z.number().int(),
    undoneAt: z.string(),
    result: z.string().describe('What the undo did, in words'),
    steps: z.array(z.string()),
  }),
  permission: 'artifacts:publish',
  effect: 'publish',
  humansOnly: true,
  target: (i) => `agent_action:${i.actionId}`,
  handler: async (input, ctx) => undoAgentAction(ctx.tx, ctx, input.actionId, ctx.principal.userId, input.note),
});

// --- Reports (#310) ------------------------------------------------------------------------------

const EmailOutcome = z
  .object({
    count: z.number().int().describe('Broadcasts published, or direct messages sent'),
    sent: z.number(),
    opened: z.number(),
    clicked: z.number(),
    unsubscribed: z.number(),
    complained: z.number(),
    bounced: z.number(),
  })
  .nullable();

export const agentReport = defineCommand({
  name: 'agents.report',
  title: 'Agent report',
  description:
    'What an agent did and what it led to in a period (default: the last 30 days): its actions by class and decision, undos and guardian episodes, the outcomes of the broadcasts it published and the messages it sent, the journeys it published against their control groups, and its mandate goals measured on its own broadcasts. Use it to review an agent and at mandate renewal.',
  input: z.object({
    agentId: AGENT_ID.optional().describe('Omit to report on the calling agent'),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  output: z.object({
    agentId: z.string(),
    from: z.string(),
    to: z.string(),
    actions: z.record(
      z.string(),
      z.object({
        allow: z.number().int(),
        hold: z.number().int(),
        ask: z.number().int(),
        deny: z.number().int(),
        failed: z.number().int(),
      }),
    ),
    undone: z.number().int(),
    guardian: z.record(z.string(), z.number().int()).describe('Guardian episodes by kind'),
    outcomes: z
      .object({
        broadcasts: EmailOutcome,
        direct: EmailOutcome,
        journeys: z.array(z.object({ id: z.string(), verdict: z.string().nullable(), note: z.string() })),
        goals: z.array(
          z.object({
            measure: z.string(),
            target: z.number().optional(),
            direction: z.enum(['up', 'down']),
            value: z.number().nullable(),
            met: z.boolean().nullable(),
            note: z.string().nullable(),
          }),
        ),
      })
      .nullable()
      .describe('Null when the server has no metric layer for reports'),
  }),
  permission: 'audit:read',
  effect: 'read',
  target: (i) => i.agentId,
  handler: async (input, ctx) => {
    const agentId = input.agentId ?? ctx.principal.agent?.id;
    if (!agentId) throw new AppError('invalid_input', 'Pass the agent id; only an agent can omit it to report on itself.');
    const [agent] = await ctx.tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!agent) throw new AppError('not_found', `Agent ${agentId} not found.`);
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new AppError('invalid_input', '`from` must be before `to`.');
    const t = schema.agentActions;
    const rows = await ctx.tx
      .select({
        actionClass: t.actionClass,
        decision: t.decision,
        // A refusal is recorded with ok = false (its transaction rolled back): it is a deny, not a failure (#321).
        failed: sql<number>`count(*) FILTER (WHERE NOT ${t.ok} AND ${t.decision} <> 'deny')::int`,
        n: sql<number>`count(*) FILTER (WHERE ${t.ok} OR ${t.decision} = 'deny')::int`,
        undone: sql<number>`count(*) FILTER (WHERE ${t.undoneAt} IS NOT NULL)::int`,
      })
      .from(t)
      .where(and(eq(t.agentId, agentId), gte(t.at, from), lt(t.at, to), sql`${t.command} <> 'artifacts.heldRecheck'`))
      .groupBy(t.actionClass, t.decision);
    const actions: Record<string, { allow: number; hold: number; ask: number; deny: number; failed: number }> = {};
    let undone = 0;
    for (const r of rows) {
      const c = actions[r.actionClass] ?? { allow: 0, hold: 0, ask: 0, deny: 0, failed: 0 };
      actions[r.actionClass] = c;
      c[r.decision as 'allow' | 'hold' | 'ask' | 'deny'] += r.n;
      c.failed += r.failed;
      undone += r.undone;
    }
    const episodes = await ctx.tx
      .select({ kind: schema.guardianEvents.kind, n: sql<number>`count(*)::int` })
      .from(schema.guardianEvents)
      .where(and(eq(schema.guardianEvents.agentId, agentId), gte(schema.guardianEvents.at, from), lt(schema.guardianEvents.at, to)))
      .groupBy(schema.guardianEvents.kind);
    const mandate = await ctx.services.activeMandate?.(ctx.tx, agentId);
    const goals = mandate?.view.goals ?? [];
    const outcomes = ctx.services.agentOutcomes
      ? await ctx.services.agentOutcomes(ctx.tx, ctx.principal.workspaceId, agentId, { from, to }, goals)
      : null;
    return {
      agentId,
      from: from.toISOString(),
      to: to.toISOString(),
      actions,
      undone,
      guardian: Object.fromEntries(episodes.map((e) => [e.kind, e.n])),
      outcomes,
    };
  },
});

// --- Autonomy settings (#215) -------------------------------------------------------------------

export const getAutonomy = defineCommand({
  name: 'workspace.autonomy',
  title: 'Autonomy settings',
  description:
    'The workspace’s limits for agents: the autonomy switch (on, propose_only, off), the audience threshold above which an agent action needs a person, per-agent limits per 24 hours, and the highest level a mandate may grant per action class (the default is a person: level 1, propose). Agents read this to plan within it.',
  input: z.object({}),
  output: AutonomySettings,
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const [w] = await ctx.tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
    return autonomySettings(w?.autonomy);
  },
});

export const setAutonomy = defineCommand({
  name: 'workspace.setAutonomy',
  title: 'Change autonomy settings',
  description:
    'Change the agent limits for the workspace. Takes effect on the next agent request. Switching to propose_only makes every agent change beyond a draft wait for a person; off leaves agents read-only.',
  input: AutonomySettings.partial(),
  output: AutonomySettings,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    const [w] = await ctx.tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
    const current = autonomySettings(w?.autonomy);
    const next = AutonomySettings.parse({
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      limits: { ...current.limits, ...(input.limits ?? {}) },
      maxLevel: { ...current.maxLevel, ...(input.maxLevel ?? {}) },
    });
    const loops = next.allowLoops;
    for (const [cls, level] of Object.entries(next.maxLevel) as [ActionClass, number][])
      if (level === 4 && !loops) throw new AppError('invalid_input', `maxLevel.${cls} is 4 (run the loop), but allowLoops is false.`);
    await ctx.tx.update(schema.workspaces).set({ autonomy: next }).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    return next;
  },
});

export const agentCommands = [
  listAgents,
  getAgent,
  updateAgent,
  pauseAgent,
  resumeAgent,
  revokeAgent,
  agentActivity,
  agentGuardian,
  clearGuard,
  shadowReport,
  agentReport,
  undoAgent,
  getAutonomy,
  setAutonomy,
];
