import { defineCommand, type Permission } from '@agentic-marketing/commands';
import { AppError, canonicalJson, sha256 } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { resolveActors } from './commands';

const Policy = z.enum(['none', 'agent_changes', 'all_publishes']);

const TIME_ZONES = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const TimeZone = z.string().describe('IANA time zone name, e.g. Europe/Copenhagen');

/** What a permission lets this principal do, under the workspace's current approval policy. */
function explainPermission(permission: Permission, policy: z.output<typeof Policy>, type: 'user' | 'agent'): string {
  switch (permission) {
    case 'artifacts:read':
      return 'Reads journeys, templates and other artifacts.';
    case 'artifacts:write':
      return 'Creates and edits drafts.';
    case 'artifacts:publish':
      if (policy === 'all_publishes')
        return 'Submits changes for review; a person approves them in the admin UI. Nobody publishes directly under this policy.';
      if (policy === 'agent_changes')
        return type === 'agent'
          ? 'Submits changes for review; a person approves them in the admin UI. You cannot publish directly.'
          : 'Publishes your own edits directly; changes written by an agent go to review for a person to approve in the admin UI.';
      return 'Publishes directly; this workspace has no approval step.';
    case 'artifacts:approve':
      return 'Approves or rejects changes in the admin UI. Agents can never use this.';
    case 'messages:send':
      return 'Sends e-mails and other messages to people. Consent, unsubscribes and suppressions are always enforced.';
    case 'audit:read':
      return 'Reads the audit log.';
    case 'profiles:read':
      return 'Reads customer profiles and events. Personal data stays hidden.';
    case 'profiles:pii':
      return 'Sees personal data in profiles, such as e-mail addresses.';
    case 'profiles:write':
      return 'Records consent and updates profile traits.';
    case 'profiles:erase':
      return 'Erases people. Agents can never use this.';
    case 'secrets:read':
      return 'Sees the names of stored secrets, never their values.';
    case 'secrets:write':
      return 'Stores and deletes secrets. Agents can never use this.';
    case 'workspace:admin':
      return 'Changes workspace settings. Agents can never use this.';
  }
}

export const getWorkspace = defineCommand({
  name: 'workspace.get',
  title: 'Current workspace',
  description:
    'The workspace you are acting in, its approval policy, time zone, test-send seed list, and your role and permissions explained.',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    approvalPolicy: Policy,
    timeZone: z.string().describe('IANA time zone of the workspace, e.g. Europe/Copenhagen'),
    seedList: z.array(z.string()).describe('Addresses (besides members) that test sends may go to'),
    you: z.object({ type: z.enum(['user', 'agent']), userId: z.string(), role: z.string(), permissions: z.array(z.string()) }),
    permissionsExplained: z
      .array(z.object({ permission: z.string(), meaning: z.string() }))
      .describe('What each of your permissions lets you do under the current approval policy'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const [w] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    const p = ctx.principal;
    const permissions = [...p.permissions].sort();
    return {
      id: w.id,
      name: w.name,
      approvalPolicy: w.approvalPolicy,
      timeZone: w.timeZone,
      seedList: w.seedList,
      you: { type: p.type, userId: p.userId, role: p.role, permissions },
      permissionsExplained: permissions.map((permission) => ({
        permission,
        meaning: explainPermission(permission, w.approvalPolicy, p.type),
      })),
    };
  },
});

export const updateWorkspace = defineCommand({
  name: 'workspace.update',
  title: 'Update workspace',
  description:
    'Admins: change the workspace name or its display time zone (an IANA name such as Europe/Copenhagen; dates are shown in it).',
  input: z
    .object({
      name: z.string().trim().min(1).max(120).optional().describe('New workspace name'),
      timeZone: TimeZone.optional().describe('IANA time zone, e.g. Europe/Copenhagen'),
    })
    .refine((input) => input.name !== undefined || input.timeZone !== undefined, 'Give a new name, timeZone, or both.'),
  output: z.object({ id: z.string(), name: z.string(), timeZone: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    if (input.timeZone !== undefined && !TIME_ZONES.has(input.timeZone))
      throw new AppError('invalid_input', 'timeZone must be an IANA time zone name, e.g. Europe/Copenhagen.');
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    };
    const [w] = await ctx.tx.update(schema.workspaces).set(changes).where(eq(schema.workspaces.id, ctx.principal.workspaceId)).returning();
    if (!w) throw new AppError('not_found', 'This workspace does not exist any more.');
    return { id: w.id, name: w.name, timeZone: w.timeZone };
  },
});

export const setSeedList = defineCommand({
  name: 'workspace.setSeedList',
  title: 'Set the test-send seed list',
  description:
    'Admins: replace the list of e-mail addresses (besides workspace members) that templates.sendTest and broadcasts.sendTest may send to. Use it for monitoring inboxes. At most 50 addresses; does not affect real broadcasts. Only people can change it.',
  input: z.object({
    seedList: z.array(z.email().max(320)).max(50).describe('E-mail addresses allowed to receive test sends'),
  }),
  output: z.object({ seedList: z.array(z.string()) }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    const seedList = [...new Set(input.seedList.map((e) => e.trim().toLowerCase()))];
    await ctx.tx.update(schema.workspaces).set({ seedList }).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    return { seedList };
  },
});

export const setApprovalPolicy = defineCommand({
  name: 'workspace.setApprovalPolicy',
  title: 'Set approval policy',
  description:
    'none: publish directly (single-person teams). agent_changes: anything an agent wrote needs a person to approve. all_publishes: every publish needs approval by someone other than the requester.',
  input: z.object({ policy: Policy }),
  output: z.object({ approvalPolicy: Policy }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    await ctx.tx.update(schema.workspaces).set({ approvalPolicy: input.policy }).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    return { approvalPolicy: input.policy };
  },
});

const AuditEntry = z.object({
  seq: z.number(),
  at: z.string(),
  principalType: z.string(),
  principalId: z.string(),
  clientId: z.string().nullable(),
  surface: z.string(),
  command: z.string(),
  effect: z.string(),
  target: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  actorName: z.string().optional().describe('Who ran it: a person, an API token (with owner) or an OAuth client'),
});

export const listAudit = defineCommand({
  name: 'audit.list',
  title: 'Read audit log',
  description: 'Who ran which command, through which surface, on what, and whether it succeeded. Newest first; page with `beforeSeq`.',
  input: z.object({
    limit: z.number().int().min(1).max(500).default(100),
    beforeSeq: z.number().int().optional(),
    target: z.string().optional().describe('Only entries about this object, e.g. an artifact id'),
  }),
  output: z.object({ entries: z.array(AuditEntry) }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.auditLog)
      .where(
        and(
          input.beforeSeq ? lt(schema.auditLog.seq, input.beforeSeq) : undefined,
          input.target ? eq(schema.auditLog.target, input.target) : undefined,
        ),
      )
      .orderBy(desc(schema.auditLog.seq))
      .limit(input.limit);
    const names = await resolveActors(
      ctx,
      rows.map((r) => ({ key: String(r.seq), type: r.principalType === 'agent' ? 'agent' : 'user', id: r.principalId, client: r.clientId })),
    );
    return {
      entries: rows.map((r) => ({
        actorName: names.get(String(r.seq))?.displayName,
        seq: r.seq,
        at: r.at.toISOString(),
        principalType: r.principalType,
        principalId: r.principalId,
        clientId: r.clientId,
        surface: r.surface,
        command: r.command,
        effect: r.effect,
        target: r.target,
        ok: r.ok,
        error: r.error,
      })),
    };
  },
});

export const verifyAudit = defineCommand({
  name: 'audit.verify',
  title: 'Verify audit log integrity',
  description: 'Recompute the hash chain of this workspace’s audit log and report the first entry that does not match, if any.',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), entries: z.number().int(), firstBrokenSeq: z.number().int().nullable() }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rows = await ctx.tx.select().from(schema.auditLog).orderBy(schema.auditLog.seq);
    let prev: string | null = null;
    for (const r of rows) {
      const entry = {
        workspaceId: r.workspaceId,
        principalType: r.principalType,
        principalId: r.principalId,
        clientId: r.clientId,
        surface: r.surface,
        command: r.command,
        effect: r.effect,
        target: r.target,
        inputHash: r.inputHash,
        ok: r.ok,
        error: r.error,
        prevHash: r.prevHash,
      };
      if (r.prevHash !== prev || r.hash !== sha256(canonicalJson(entry))) return { ok: false, entries: rows.length, firstBrokenSeq: r.seq };
      prev = r.hash;
    }
    return { ok: true, entries: rows.length, firstBrokenSeq: null };
  },
});

export const workspaceCommands = [getWorkspace, updateWorkspace, setSeedList, setApprovalPolicy, listAudit, verifyAudit] as const;
