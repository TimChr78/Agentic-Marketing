import { defineCommand } from '@agentic-marketing/commands';
import { canonicalJson, sha256 } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

const Policy = z.enum(['none', 'agent_changes', 'all_publishes']);

export const getWorkspace = defineCommand({
  name: 'workspace.get',
  title: 'Current workspace',
  description: 'The workspace you are acting in, its approval policy, and your role and permissions.',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    approvalPolicy: Policy,
    you: z.object({ type: z.enum(['user', 'agent']), userId: z.string(), role: z.string(), permissions: z.array(z.string()) }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const [w] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    const p = ctx.principal;
    return {
      id: w.id,
      name: w.name,
      approvalPolicy: w.approvalPolicy,
      you: { type: p.type, userId: p.userId, role: p.role, permissions: [...p.permissions].sort() },
    };
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
});

export const listAudit = defineCommand({
  name: 'audit.list',
  title: 'Read audit log',
  description: 'Who ran which command, through which surface, on what, and whether it succeeded. Newest first; page with `beforeSeq`.',
  input: z.object({ limit: z.number().int().min(1).max(500).default(100), beforeSeq: z.number().int().optional() }),
  output: z.object({ entries: z.array(AuditEntry) }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.auditLog)
      .where(input.beforeSeq ? lt(schema.auditLog.seq, input.beforeSeq) : undefined)
      .orderBy(desc(schema.auditLog.seq))
      .limit(input.limit);
    return {
      entries: rows.map((r) => ({
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

export const workspaceCommands = [getWorkspace, setApprovalPolicy, listAudit, verifyAudit] as const;
