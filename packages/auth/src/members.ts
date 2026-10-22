import { randomBytes } from 'node:crypto';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId, sha256 } from '@agentic-marketing/core';
import { type Db, type Role, schema } from '@agentic-marketing/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

// Members and invitations. Owners and admins manage members; only owners can make or change
// owners, and a workspace always keeps at least one owner. Agents can list members but never
// change them.

/** Names and e-mail addresses of people, which live in the auth tables rather than in a workspace. */
export interface Directory {
  users(ids: string[]): Promise<Map<string, { email: string; name: string }>>;
}

declare module '@agentic-marketing/commands' {
  interface Services {
    directory: Directory;
  }
}

export function authDirectory(db: Db): Directory {
  return {
    async users(ids) {
      if (!ids.length) return new Map();
      const { rows } = await db.admin.query<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM "user" WHERE id = ANY($1)',
        [ids],
      );
      return new Map(rows.map((r) => [r.id, { email: r.email, name: r.name }]));
    },
  };
}

const RoleSchema = z.enum(['owner', 'admin', 'marketer', 'approver', 'viewer']);
const INVITATION_DAYS = 7;

const tokenHash = (token: string) => sha256(`invitation:${token}`);

/** Only owners may grant, change or take away the owner role. */
function assertMayManage(ctx: CommandContext, ...roles: Role[]) {
  if (roles.includes('owner') && ctx.principal.role !== 'owner')
    throw new AppError('forbidden', 'Only an owner can make someone an owner or change an owner.');
}

/** Locks the workspace's owner rows so two concurrent changes cannot remove the last owner. */
async function assertAnotherOwner(ctx: CommandContext, userId: string) {
  const owners = await ctx.tx.execute<{ user_id: string }>(
    sql`SELECT user_id FROM workspace_members WHERE workspace_id = ${ctx.principal.workspaceId} AND role = 'owner' FOR UPDATE`,
  );
  if (!owners.rows.some((o) => o.user_id !== userId))
    throw new AppError('conflict', 'A workspace needs at least one owner. Make someone else an owner first.');
}

async function memberOf(ctx: CommandContext, userId: string) {
  const [m] = await ctx.tx
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceMembers.userId, userId)));
  if (!m) throw new AppError('not_found', `No member with user id ${userId} in this workspace. List members with members.list.`);
  return m;
}

const Member = z.object({ userId: z.string(), email: z.string(), name: z.string(), role: RoleSchema, since: z.string() });

export const listMembers = defineCommand({
  name: 'members.list',
  title: 'List members',
  description: 'People in this workspace and their roles.',
  input: z.object({}),
  output: z.object({ members: z.array(Member) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rows = await ctx.tx.select().from(schema.workspaceMembers).orderBy(schema.workspaceMembers.createdAt);
    const people = await ctx.services.directory.users(rows.map((r) => r.userId));
    return {
      members: rows.map((r) => ({
        userId: r.userId,
        email: people.get(r.userId)?.email ?? '',
        name: people.get(r.userId)?.name ?? '',
        role: r.role,
        since: r.createdAt.toISOString(),
      })),
    };
  },
});

const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: RoleSchema,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const invitationOut = (r: typeof schema.invitations.$inferSelect) => ({
  id: r.id,
  email: r.email,
  role: r.role,
  status: r.status === 'pending' && r.expiresAt < new Date() ? ('expired' as const) : r.status,
  invitedBy: r.invitedBy,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
});

export const inviteMember = defineCommand({
  name: 'members.invite',
  title: 'Invite a person',
  description: `Create a one-time invitation link for an e-mail address, valid for ${INVITATION_DAYS} days. The token is shown only in this response; share the link with the person. They accept it while signed in with that e-mail address.`,
  input: z.object({ email: z.email().max(320), role: RoleSchema }),
  output: Invitation.extend({ token: z.string(), acceptPath: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['token', 'acceptPath'],
  target: (i) => i.email.toLowerCase(),
  handler: async (input, ctx) => {
    assertMayManage(ctx, input.role);
    const email = input.email.toLowerCase();
    const existing = await ctx.tx.execute<{ user_id: string }>(
      sql`SELECT m.user_id FROM workspace_members m WHERE m.workspace_id = ${ctx.principal.workspaceId}`,
    );
    const people = await ctx.services.directory.users(existing.rows.map((r) => r.user_id));
    if ([...people.values()].some((p) => p.email.toLowerCase() === email))
      throw new AppError('conflict', `${email} is already a member. Change their role with members.setRole.`);

    const token = randomBytes(32).toString('base64url');
    const [row] = await ctx.tx
      .insert(schema.invitations)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('inv'),
        email,
        role: input.role,
        tokenHash: tokenHash(token),
        invitedBy: ctx.principal.userId,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
      })
      .onConflictDoNothing()
      .returning();
    if (!row)
      throw new AppError('conflict', `${email} already has an open invitation. Revoke it with invitations.revoke to send a new one.`);
    return { ...invitationOut(row), token, acceptPath: `/invite#${token}` };
  },
});

export const listInvitations = defineCommand({
  name: 'invitations.list',
  title: 'List invitations',
  description: 'Invitations of this workspace, newest first. Pending invitations past their expiry are reported as expired.',
  input: z.object({ status: z.enum(['pending', 'accepted', 'revoked']).optional() }),
  output: z.object({ invitations: z.array(Invitation) }),
  permission: 'workspace:admin',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.invitations)
      .where(input.status ? eq(schema.invitations.status, input.status) : undefined)
      .orderBy(desc(schema.invitations.createdAt));
    return { invitations: rows.map(invitationOut) };
  },
});

export const revokeInvitation = defineCommand({
  name: 'invitations.revoke',
  title: 'Revoke an invitation',
  description: 'Make a pending invitation link stop working.',
  input: z.object({ id: z.string() }),
  output: Invitation,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .update(schema.invitations)
      .set({ status: 'revoked', decidedAt: new Date() })
      .where(and(eq(schema.invitations.id, input.id), eq(schema.invitations.status, 'pending')))
      .returning();
    if (!row) throw new AppError('not_found', `No pending invitation ${input.id}. List them with invitations.list.`);
    return invitationOut(row);
  },
});

export const setMemberRole = defineCommand({
  name: 'members.setRole',
  title: 'Change a member’s role',
  description: 'Give a member another role. Only owners can make someone an owner or change an owner; the last owner cannot be demoted.',
  input: z.object({ userId: z.string(), role: RoleSchema }),
  output: z.object({ userId: z.string(), role: RoleSchema }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.userId,
  handler: async (input, ctx) => {
    const m = await memberOf(ctx, input.userId);
    assertMayManage(ctx, m.role, input.role);
    if (m.role === 'owner' && input.role !== 'owner') await assertAnotherOwner(ctx, input.userId);
    await ctx.tx
      .update(schema.workspaceMembers)
      .set({ role: input.role })
      .where(and(eq(schema.workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceMembers.userId, input.userId)));
    return { userId: input.userId, role: input.role };
  },
});

export const removeMember = defineCommand({
  name: 'members.remove',
  title: 'Remove a member',
  description:
    'Take a person out of this workspace. Their sessions and connected agents lose access immediately. The last owner cannot be removed.',
  input: z.object({ userId: z.string() }),
  output: z.object({ userId: z.string(), removed: z.literal(true) }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.userId,
  handler: async (input, ctx) => {
    const m = await memberOf(ctx, input.userId);
    assertMayManage(ctx, m.role);
    if (m.role === 'owner') await assertAnotherOwner(ctx, input.userId);
    await ctx.tx
      .delete(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceMembers.userId, input.userId)));
    return { userId: input.userId, removed: true as const };
  },
});

export const memberCommands = [listMembers, inviteMember, listInvitations, revokeInvitation, setMemberRole, removeMember] as const;

// Accepting an invitation. The invitee is not a member yet, so this command is not part of the
// public registry: the server finds the workspace from the token and runs it for the signed-in
// person (see `invitationWorkspace`), which keeps it in the audit log of that workspace.

export const acceptInvitation = defineCommand({
  name: 'invitations.accept',
  title: 'Accept an invitation',
  description: 'Join a workspace with an invitation token, as the signed-in person.',
  input: z.object({ token: z.string().min(1), email: z.string() }),
  output: z.object({ workspaceId: z.string(), role: RoleSchema }),
  permission: null,
  effect: 'write',
  humansOnly: true,
  sensitive: ['token'],
  handler: async (input, ctx) => {
    const [inv] = await ctx.tx
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.tokenHash, tokenHash(input.token)));
    if (inv?.status !== 'pending' || inv.expiresAt < new Date())
      throw new AppError('not_found', 'This invitation link is not valid any more. Ask for a new one.');
    if (inv.email !== input.email.toLowerCase())
      throw new AppError('forbidden', `This invitation is for ${inv.email}. Sign in with that address to accept it.`);
    const added = await ctx.tx
      .insert(schema.workspaceMembers)
      .values({ workspaceId: inv.workspaceId, userId: ctx.principal.userId, role: inv.role })
      .onConflictDoNothing()
      .returning();
    if (!added.length) throw new AppError('conflict', 'You are already a member of this workspace.');
    await ctx.tx
      .update(schema.invitations)
      .set({ status: 'accepted', acceptedBy: ctx.principal.userId, decidedAt: new Date() })
      .where(eq(schema.invitations.id, inv.id));
    return { workspaceId: inv.workspaceId, role: inv.role };
  },
});

/** The workspace (and invited role) an invitation token belongs to, read with the admin connection. */
export async function invitationWorkspace(db: Db, token: string): Promise<{ workspaceId: string; role: Role } | null> {
  const { rows } = await db.admin.query<{ workspace_id: string; role: Role }>(
    'SELECT workspace_id, role FROM invitations WHERE token_hash = $1',
    [tokenHash(token)],
  );
  return rows[0] ? { workspaceId: rows[0].workspace_id, role: rows[0].role } : null;
}
