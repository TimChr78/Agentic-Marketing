import { estimatedCost } from '@agentic-marketing/ai';
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
 * What one agent's coordination looks like (#426): the artifacts it owns and the pending changes
 * other agents have on them (a hold inside its veto window, or an open approval request). People
 * and this agent's own requests are left out.
 */
async function coordinationOf(tx: Tx, agentId: string) {
  const owned = await tx
    .select({ id: schema.artifacts.id, name: schema.artifacts.name })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.ownerAgentId, agentId));
  const ids = owned.map((a) => a.id);
  if (!ids.length) return { ownedArtifacts: [] as string[], heldConflicts: [] };
  const names = new Map(owned.map((a) => [a.id, a.name]));
  const pending = await tx.execute<{
    artifact_id: string;
    hold_until: Date | string | null;
    agent_id: string;
    agent_name: string;
  }>(sql`
    SELECT ar.artifact_id, ar.hold_until, a.id AS agent_id, a.name AS agent_name
    FROM approval_requests ar
    JOIN agent_credentials c ON c.workspace_id = ar.workspace_id AND (
      (c.kind = 'api_token' AND ar.requested_by_client = 'token:' || c.credential_id)
      OR (c.kind = 'hosted' AND ar.requested_by_client = 'hosted:' || c.credential_id)
      OR (c.kind = 'copilot' AND ar.requested_by_client = 'copilot:' || c.credential_id)
      OR (c.kind = 'oauth_client' AND ar.requested_by_client = c.credential_id))
    JOIN agents a ON a.workspace_id = c.workspace_id AND a.id = c.agent_id
    WHERE ar.status = 'pending' AND ar.requested_by_type = 'agent'
      AND ar.artifact_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND a.id <> ${agentId}
    ORDER BY ar.created_at`);
  const seen = new Set<string>();
  const heldConflicts: {
    artifactId: string;
    artifactName: string;
    agentId: string;
    agentName: string;
    kind: 'hold' | 'approval';
    until: string | null;
  }[] = [];
  for (const row of pending.rows) {
    const key = `${row.artifact_id}:${row.agent_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const until = row.hold_until ? new Date(row.hold_until) : null;
    heldConflicts.push({
      artifactId: row.artifact_id,
      artifactName: names.get(row.artifact_id) ?? row.artifact_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      kind: until && until > new Date() ? 'hold' : 'approval',
      until: until && until > new Date() ? until.toISOString() : null,
    });
  }
  return { ownedArtifacts: ids, heldConflicts };
}

/** Marketing messages this agent sent that the contact-pressure cap skipped (#426). */
async function contactPressureSkipped(tx: Tx, agentId: string, range?: { from: Date; to: Date }): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.agentId, agentId),
        sql`${schema.messages.reason} LIKE 'agent_contact_pressure:%'`,
        range ? gte(schema.messages.createdAt, range.from) : undefined,
        range ? lt(schema.messages.createdAt, range.to) : undefined,
      ),
    );
  return n;
}

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

const Credential = z.object({ kind: z.enum(['api_token', 'oauth_client', 'hosted', 'copilot']), id: z.string(), since: z.string() });
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

/** Another agent's pending change on an artifact this agent owns (#426). */
const HeldConflict = z.object({
  artifactId: z.string(),
  artifactName: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  kind: z.enum(['hold', 'approval']).describe('hold: inside its veto window; approval: waiting for a person'),
  until: z.string().nullable().describe('For a hold, when its veto window ends'),
});

export const agentActivity = defineCommand({
  name: 'agents.activity',
  title: 'Agent activity',
  description:
    'The action ledger: every agent write with the policy decision (allow, ask = waited for a person, deny = refused) and its reasons, the impact estimate (e.g. people reached) and whether it succeeded. Newest first; page with `before`. With an agent id it also shows the artifacts that agent owns, the pending changes other agents have on them, and how many of its messages the contact-pressure cap skipped.',
  input: z.object({
    agentId: AGENT_ID.optional(),
    decision: z.enum(['allow', 'hold', 'ask', 'deny']).optional(),
    actionClass: z.string().optional(),
    since: z.string().datetime().optional(),
    before: z.number().int().optional().describe('Return entries with a smaller id (the last id of the previous page)'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    actions: z.array(Action),
    next: z.number().int().nullable(),
    ownedArtifacts: z.array(z.string()).optional().describe('Artifacts this agent owns (#426); only with an agent id'),
    heldConflicts: z
      .array(HeldConflict)
      .optional()
      .describe('Other agents’ pending changes on the artifacts it owns; only with an agent id'),
    contactPressureSkipped: z
      .number()
      .int()
      .optional()
      .describe('Marketing messages of this agent that the contact-pressure cap skipped (#426); only with an agent id'),
  }),
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
      ...(input.agentId
        ? {
            ...(await coordinationOf(ctx.tx, input.agentId)),
            contactPressureSkipped: await contactPressureSkipped(ctx.tx, input.agentId),
          }
        : {}),
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

const GoalOutcome = z.object({
  measure: z.string(),
  target: z.number().optional(),
  direction: z.enum(['up', 'down']),
  value: z.number().nullable(),
  met: z.boolean().nullable(),
  note: z.string().nullable(),
});

const Outcomes = z
  .object({
    broadcasts: EmailOutcome,
    direct: EmailOutcome,
    journeys: z.array(z.object({ id: z.string(), verdict: z.string().nullable(), note: z.string() })),
    goals: z.array(GoalOutcome),
  })
  .nullable();

const ActionTally = z.object({
  allow: z.number().int(),
  hold: z.number().int(),
  ask: z.number().int(),
  deny: z.number().int(),
  failed: z.number().int(),
});

/** The artifacts an agent has published at any time, from its ledger. */
async function publishedArtifactIds(tx: Tx, agentId: string): Promise<string[]> {
  const t = schema.agentActions;
  const rows = await tx
    .select({ target: t.target })
    .from(t)
    .where(
      and(
        eq(t.agentId, agentId),
        eq(t.decision, 'allow'),
        eq(t.ok, true),
        sql`${t.command} IN ('artifacts.requestPublish', 'artifacts.requestPublishBundle')`,
      ),
    );
  return [...new Set(rows.flatMap((r) => (r.target ?? '').split(',')).filter(Boolean))];
}

/** The agent's audience syncs with their current size, last run and platforms (#428). */
async function audienceSyncsOf(tx: Tx, artifactIds: string[]) {
  const syncIds = artifactIds.filter((id) => id.startsWith('aud_'));
  if (!syncIds.length) return [];
  const rows = await tx
    .select({ id: schema.artifacts.id, name: schema.artifacts.name, content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(
      and(inArray(schema.artifacts.id, syncIds), eq(schema.artifacts.type, 'audience_sync'), isNotNull(schema.artifacts.publishedVersion)),
    );
  const states = await tx
    .select({
      syncId: schema.audienceSyncState.syncId,
      platform: schema.audienceSyncState.platform,
      members: schema.audienceSyncState.members,
      lastRunAt: schema.audienceSyncState.lastRunAt,
    })
    .from(schema.audienceSyncState)
    .where(inArray(schema.audienceSyncState.syncId, syncIds));
  return rows.map((r) => {
    const own = states.filter((s) => s.syncId === r.id);
    const content = (r.content ?? {}) as { meta?: unknown; google?: unknown };
    const platforms = ['meta', 'google'].filter((p) => content[p as 'meta' | 'google'] || own.some((s) => s.platform === p));
    const members = own.reduce((n, s) => Math.max(n, s.members), 0);
    const last = own.map((s) => s.lastRunAt).sort((a, b) => b.getTime() - a.getTime())[0];
    return { id: r.id, name: r.name, members, lastSync: last?.toISOString() ?? null, platforms };
  });
}

/** Ad conversion uploads in the period, when the agent published the workspace's conversion map (#428). */
async function conversionUploadsOf(tx: Tx, artifactIds: string[], range: { from: Date; to: Date }) {
  if (!artifactIds.some((id) => id.startsWith('cvm_'))) return undefined;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.kind, 'ad_conversion'),
        gte(schema.deliveries.createdAt, range.from),
        lt(schema.deliveries.createdAt, range.to),
      ),
    );
  return row?.n ?? 0;
}

/** The agents' hosted AI usage and estimated cost in the period (#428), in one grouped read (#489). */
async function aiCostsOf(tx: Tx, agentIds: string[], range: { from: Date; to: Date }) {
  const out = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cost: number | null }>();
  if (!agentIds.length) return out;
  const c = schema.aiCalls;
  const rows = await tx
    .select({
      agentId: sql<string>`${c.input}->>'hostedAgentId'`,
      model: c.model,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${c.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${c.outputTokens}), 0)::int`,
    })
    .from(c)
    .where(
      and(
        eq(c.kind, 'hosted'),
        sql`${c.input}->>'hostedAgentId' IN (${sql.join(
          agentIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        gte(c.createdAt, range.from),
        lt(c.createdAt, range.to),
      ),
    )
    .groupBy(sql`${c.input}->>'hostedAgentId'`, c.model);
  for (const r of rows) {
    const acc = out.get(r.agentId) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: null };
    acc.calls += r.calls;
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    const cost = estimatedCost(r.model, r.inputTokens, r.outputTokens);
    if (cost !== null) acc.cost = Math.round(((acc.cost ?? 0) + cost) * 1e6) / 1e6;
    out.set(r.agentId, acc);
  }
  return out;
}

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
    ownedArtifacts: z.array(z.string()).optional().describe('Artifacts this agent owns (#426)'),
    heldConflicts: z.array(HeldConflict).optional().describe('Other agents’ pending changes on the artifacts it owns (#426)'),
    contactPressureSkipped: z
      .number()
      .int()
      .optional()
      .describe('Marketing messages of this agent that the contact-pressure cap skipped in the period (#426)'),
    audienceSyncs: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          members: z.number().int().describe('People in the synced audience, from the last run'),
          lastSync: z.string().nullable(),
          platforms: z.array(z.string()),
        }),
      )
      .optional()
      .describe('Audience syncs this agent published, with their size, last run and platforms (#428)'),
    conversionUploads: z
      .number()
      .int()
      .optional()
      .describe('Ad conversion uploads in the period, when this agent published the conversion map (#428)'),
    outcomes: Outcomes.describe('Null when the server has no metric layer for reports'),
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
    const published = await publishedArtifactIds(ctx.tx, agentId);
    const audienceSyncs = await audienceSyncsOf(ctx.tx, published);
    const conversionUploads = await conversionUploadsOf(ctx.tx, published, { from, to });
    return {
      agentId,
      from: from.toISOString(),
      to: to.toISOString(),
      actions,
      undone,
      guardian: Object.fromEntries(episodes.map((e) => [e.kind, e.n])),
      ...(await coordinationOf(ctx.tx, agentId)),
      contactPressureSkipped: await contactPressureSkipped(ctx.tx, agentId, { from, to }),
      ...(audienceSyncs.length ? { audienceSyncs } : {}),
      ...(conversionUploads !== undefined ? { conversionUploads } : {}),
      outcomes,
    };
  },
});

// --- Comparison (#428) ---------------------------------------------------------------------------

/** A comparison is bounded so one call cannot fan out without limit (#489). */
const COMPARE_MAX_AGENTS = 20;
const COMPARE_MAX_WINDOW_DAYS = 366;

const MandateComparison = z.object({
  mandateId: z.string().nullable().describe('Null: actions recorded without a mandate'),
  version: z.number().int().nullable(),
  validUntil: z.string().nullable(),
  active: z.boolean().describe('Whether this mandate version is still in force'),
  actions: z.record(z.string(), ActionTally),
  undone: z.number().int(),
  holds: z.object({
    rejected: z.number().int().describe('Holds a person vetoed'),
    ran: z.number().int().describe('Holds that ran after their veto window'),
    pending: z.number().int(),
  }),
});

const AgentComparison = z.object({
  agentId: z.string(),
  name: z.string(),
  status: z.string(),
  outcomes: Outcomes.describe('What its actions led to in the period; null without a metric layer'),
  goalsMet: z.number().int(),
  goalsTotal: z.number().int(),
  guardian: z.object({
    caps: z.number().int().describe('Guardian episodes that capped the agent in the period'),
    episodes: z.record(z.string(), z.number().int()).describe('All guardian episodes by kind'),
  }),
  ai: z.object({
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cost: z.number().nullable().describe('Estimated USD from the price table; null for an unknown model'),
  }),
  mandates: z.array(MandateComparison).describe('One entry per mandate version the agent acted under, plus its actions without one'),
});

export const compareAgents = defineCommand({
  name: 'agents.compare',
  title: 'Compare agents',
  description:
    'Put several agents side by side for a period (default: the last 30 days, at most 366): per mandate version, actions by class and decision (ran, held, sent to a person, refused, failed), undos and holds vetoed or run; per agent, the outcomes of its broadcasts, direct messages and journeys, its mandate goals, guardian caps and its hosted AI usage and estimated cost. At most 20 agents are compared: pass agentIds, or omit them for the 20 most recently active agents; `truncated` says whether others were left out.',
  input: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    agentIds: z
      .array(AGENT_ID)
      .optional()
      .describe(`Agents to compare; at most ${COMPARE_MAX_AGENTS}; omit for the ${COMPARE_MAX_AGENTS} most recently active`),
  }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    truncated: z.boolean().describe('True when more agents had activity than the comparison includes; compare explicit ids to see others'),
    agents: z.array(AgentComparison),
  }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    if (input.agentIds && input.agentIds.length > COMPARE_MAX_AGENTS)
      throw new AppError('invalid_input', `Compare at most ${COMPARE_MAX_AGENTS} agents; pass fewer ids.`);
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new AppError('invalid_input', '`from` must be before `to`.');
    if (to.getTime() - from.getTime() > COMPARE_MAX_WINDOW_DAYS * 86_400_000)
      throw new AppError('invalid_input', `The comparison window is at most ${COMPARE_MAX_WINDOW_DAYS} days; narrow \`from\` and \`to\`.`);
    // Most recently active first, and the cap applies to the resolved set, not only to explicit ids
    // (#489): omitting agentIds must not load and compare every agent in the workspace.
    const lastActive = sql<Date | null>`(SELECT max(aa.at) FROM agent_actions aa
      WHERE aa.workspace_id = ${schema.agents.workspaceId} AND aa.agent_id = ${schema.agents.id})`;
    const resolved = await ctx.tx
      .select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status })
      .from(schema.agents)
      .where(input.agentIds ? inArray(schema.agents.id, input.agentIds) : undefined)
      .orderBy(desc(sql`coalesce(${lastActive}, ${schema.agents.createdAt})`), schema.agents.name)
      .limit(COMPARE_MAX_AGENTS + 1);
    if (input.agentIds) {
      const found = new Set(resolved.map((a) => a.id));
      const missing = input.agentIds.filter((id) => !found.has(id));
      if (missing.length) throw new AppError('not_found', `Agent ${missing.join(', ')} not found.`);
    }
    const truncated = !input.agentIds && resolved.length > COMPARE_MAX_AGENTS;
    const agents = truncated ? resolved.slice(0, COMPARE_MAX_AGENTS) : resolved;
    const t = schema.agentActions;
    const agentIds = agents.map((a) => a.id);
    const now = new Date();
    type Bucket = z.output<typeof MandateComparison>;
    const bucketsByAgent = new Map<string, Map<string, Bucket>>();
    const bucketsOf = (agentId: string) => {
      let buckets = bucketsByAgent.get(agentId);
      if (!buckets) {
        buckets = new Map();
        bucketsByAgent.set(agentId, buckets);
      }
      return buckets;
    };
    const bucketOf = (agentId: string, mandateId: string | null, version: number | null) => {
      const buckets = bucketsOf(agentId);
      const key = `${mandateId ?? ''}|${version ?? ''}`;
      let b = buckets.get(key);
      if (!b) {
        b = { mandateId, version, validUntil: null, active: false, actions: {}, undone: 0, holds: { rejected: 0, ran: 0, pending: 0 } };
        buckets.set(key, b);
      }
      return b;
    };

    // Actions and holds for every compared agent in one grouped read each, instead of eight per agent (#489).
    const actionRows = agentIds.length
      ? await ctx.tx
          .select({
            agentId: t.agentId,
            mandateId: t.mandateId,
            mandateVersion: t.mandateVersion,
            actionClass: t.actionClass,
            decision: t.decision,
            // A refusal is recorded with ok = false: it is a deny, not a failure (#321).
            failed: sql<number>`count(*) FILTER (WHERE NOT ${t.ok} AND ${t.decision} <> 'deny')::int`,
            n: sql<number>`count(*) FILTER (WHERE ${t.ok} OR ${t.decision} = 'deny')::int`,
            undone: sql<number>`count(*) FILTER (WHERE ${t.undoneAt} IS NOT NULL)::int`,
          })
          .from(t)
          .where(and(inArray(t.agentId, agentIds), gte(t.at, from), lt(t.at, to), sql`${t.command} <> 'artifacts.heldRecheck'`))
          .groupBy(t.agentId, t.mandateId, t.mandateVersion, t.actionClass, t.decision)
      : [];
    for (const r of actionRows) {
      const b = bucketOf(r.agentId, r.mandateId, r.mandateVersion);
      const c = b.actions[r.actionClass] ?? { allow: 0, hold: 0, ask: 0, deny: 0, failed: 0 };
      b.actions[r.actionClass] = c;
      c[r.decision as 'allow' | 'hold' | 'ask' | 'deny'] += r.n;
      c.failed += r.failed;
      b.undone += r.undone;
    }
    // Holds are approval requests linked from the hold rows; their outcome is a person's veto or the window ending.
    // A recheck row copies the hold it announces, so it must not count as a second hold (#470).
    const holdRows = agentIds.length
      ? await ctx.tx
          .select({
            agentId: t.agentId,
            mandateId: t.mandateId,
            mandateVersion: t.mandateVersion,
            approvalId: sql<string | null>`${t.impact}->>'approvalId'`,
          })
          .from(t)
          .where(
            and(
              inArray(t.agentId, agentIds),
              eq(t.decision, 'hold'),
              sql`${t.command} <> 'artifacts.heldRecheck'`,
              gte(t.at, from),
              lt(t.at, to),
            ),
          )
      : [];
    const approvalIds = [...new Set(holdRows.map((r) => r.approvalId).filter((id): id is string => !!id))];
    const approvals = approvalIds.length
      ? await ctx.tx
          .select({
            id: schema.approvalRequests.id,
            status: schema.approvalRequests.status,
            decidedBy: schema.approvalRequests.decidedBy,
          })
          .from(schema.approvalRequests)
          .where(inArray(schema.approvalRequests.id, approvalIds))
      : [];
    const approvalById = new Map(approvals.map((a) => [a.id, a]));
    for (const r of holdRows) {
      const b = bucketOf(r.agentId, r.mandateId, r.mandateVersion);
      const a = r.approvalId ? approvalById.get(r.approvalId) : undefined;
      if (a?.status === 'rejected') b.holds.rejected++;
      else if (a?.status === 'approved' && a.decidedBy === 'policy:hold') b.holds.ran++;
      else if (a?.status === 'pending') b.holds.pending++;
    }
    // The version's own validUntil and current state, so a comparison across renewals shows which terms
    // applied then and which authority is still in force now (#458).
    const mandateIds = [
      ...new Set(
        [...bucketsByAgent.values()].flatMap((buckets) => [...buckets.values()].map((b) => b.mandateId)).filter((id): id is string => !!id),
      ),
    ];
    if (mandateIds.length) {
      const versions = await ctx.tx
        .select({
          artifactId: schema.artifactVersions.artifactId,
          number: schema.artifactVersions.number,
          content: schema.artifactVersions.content,
          state: schema.artifactVersions.state,
          archived: schema.artifacts.archived,
          publishedVersion: schema.artifacts.publishedVersion,
        })
        .from(schema.artifactVersions)
        .innerJoin(
          schema.artifacts,
          and(
            eq(schema.artifacts.workspaceId, schema.artifactVersions.workspaceId),
            eq(schema.artifacts.id, schema.artifactVersions.artifactId),
          ),
        )
        .where(inArray(schema.artifactVersions.artifactId, mandateIds));
      const byVersion = new Map(versions.map((v) => [`${v.artifactId}|${v.number}`, v]));
      for (const buckets of bucketsByAgent.values())
        for (const b of buckets.values()) {
          if (!b.mandateId) continue;
          const version = byVersion.get(`${b.mandateId}|${b.version}`);
          const content = version?.content as { validUntil?: string } | undefined;
          if (!content?.validUntil) continue;
          const until = new Date(content.validUntil);
          b.validUntil = until.toISOString();
          // In force now: the published, unarchived version itself, not merely an unexpired version (#458).
          b.active = until > now && version?.state === 'published' && version.publishedVersion === b.version && version.archived === false;
        }
    }
    const episodesByAgent = new Map<string, { kind: string; action: string; n: number }[]>();
    if (agentIds.length) {
      const episodes = await ctx.tx
        .select({
          agentId: schema.guardianEvents.agentId,
          kind: schema.guardianEvents.kind,
          action: schema.guardianEvents.action,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.guardianEvents)
        .where(and(inArray(schema.guardianEvents.agentId, agentIds), gte(schema.guardianEvents.at, from), lt(schema.guardianEvents.at, to)))
        .groupBy(schema.guardianEvents.agentId, schema.guardianEvents.kind, schema.guardianEvents.action);
      for (const e of episodes) {
        const list = episodesByAgent.get(e.agentId) ?? [];
        list.push({ kind: e.kind, action: e.action, n: e.n });
        episodesByAgent.set(e.agentId, list);
      }
    }
    const aiByAgent = await aiCostsOf(ctx.tx, agentIds, { from, to });
    // Mandates in one grouped read; outcomes in one grouped ledger read, with the bounded
    // metric-layer queries that follow. Neither is one database round trip per agent anymore (#489).
    const mandatesByAgent = ctx.services.activeMandates
      ? await ctx.services.activeMandates(ctx.tx, agentIds)
      : new Map(await Promise.all(agents.map(async (a) => [a.id, (await ctx.services.activeMandate?.(ctx.tx, a.id)) ?? null] as const)));
    const goalsByAgent = new Map(agents.map((a) => [a.id, mandatesByAgent.get(a.id)?.view.goals ?? []]));
    const outcomesByAgent = ctx.services.agentOutcomesMany
      ? await ctx.services.agentOutcomesMany(
          ctx.tx,
          ctx.principal.workspaceId,
          agents.map((a) => ({ agentId: a.id, goals: goalsByAgent.get(a.id) ?? [] })),
          { from, to },
        )
      : new Map(
          await Promise.all(
            agents.map(
              async (a) =>
                [
                  a.id,
                  ctx.services.agentOutcomes
                    ? await ctx.services.agentOutcomes(ctx.tx, ctx.principal.workspaceId, a.id, { from, to }, goalsByAgent.get(a.id) ?? [])
                    : null,
                ] as const,
            ),
          ),
        );
    const compared: z.output<typeof AgentComparison>[] = [];
    for (const agent of agents) {
      const episodes = episodesByAgent.get(agent.id) ?? [];
      const outcomes = outcomesByAgent.get(agent.id) ?? null;
      compared.push({
        agentId: agent.id,
        name: agent.name,
        status: agent.status,
        outcomes,
        goalsMet: outcomes?.goals.filter((g) => g.met === true).length ?? 0,
        goalsTotal: outcomes?.goals.length ?? 0,
        guardian: {
          caps: episodes.filter((e) => e.action === 'cap').reduce((n, e) => n + e.n, 0),
          episodes: episodes.reduce<Record<string, number>>((acc, e) => {
            acc[e.kind] = (acc[e.kind] ?? 0) + e.n;
            return acc;
          }, {}),
        },
        ai: aiByAgent.get(agent.id) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: null },
        mandates: [...(bucketsByAgent.get(agent.id)?.values() ?? [])].sort(
          (a, b) => (a.validUntil ?? '').localeCompare(b.validUntil ?? '') || (a.version ?? 0) - (b.version ?? 0),
        ),
      });
    }
    return { from: from.toISOString(), to: to.toISOString(), truncated, agents: compared };
  },
});

// --- Autonomy settings (#215) -------------------------------------------------------------------

export const getAutonomy = defineCommand({
  name: 'workspace.autonomy',
  title: 'Autonomy settings',
  description:
    'The workspace’s limits for agents: the autonomy switch (on, propose_only, off), the audience threshold above which an agent action needs a person, per-agent limits per 24 hours, the highest level a mandate may grant per action class (the default is a person: level 1, propose), and the cross-agent contact-pressure caps. Agents read this to plan within it.',
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
  compareAgents,
  undoAgent,
  getAutonomy,
  setAutonomy,
];
