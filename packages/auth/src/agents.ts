import {
  type ActionClass,
  AutonomySettings,
  autonomySettings,
  type CommandContext,
  defineCommand,
  type Principal,
} from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type AgentCredentialKind, type AgentStatus, type Db, schema } from '@agentic-marketing/db';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
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
  reasons: z.array(z.string()),
  impact: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  error: z.string().nullable(),
  target: z.string().nullable(),
  surface: z.string(),
  at: z.string(),
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
    return {
      actions: page.map((r) => ({ ...r, at: r.at.toISOString(), impact: r.impact ?? {} })),
      next: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
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
  getAutonomy,
  setAutonomy,
];
