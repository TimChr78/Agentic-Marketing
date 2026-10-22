import { randomBytes } from 'node:crypto';
import { type CommandContext, defineCommand, type Principal } from '@agentic-marketing/commands';
import { AppError, sha256 } from '@agentic-marketing/core';
import type { Db, Role } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

// SCIM 2.0 provisioning: the identity provider keeps a workspace's members in step with the
// company directory. People are created, updated and deactivated through /scim/v2 (see the
// server's scim route); here are the settings commands for owners and admins, and the internal
// commands the route runs, so every change goes through the executor and the audit log.

const MANAGED = ['admin', 'marketer', 'approver', 'viewer'] as const;
const ManagedRole = z.enum(MANAGED);
const RANK: Record<string, number> = { viewer: 1, approver: 2, marketer: 3, admin: 4 };

export const scimTokenHash = (token: string) => sha256(`scim:${token}`);

/** The principal SCIM requests act as: the identity provider, allowed to manage members only. */
export const scimPrincipal = (workspaceId: string): Principal => ({
  type: 'agent',
  userId: 'scim',
  clientId: 'scim',
  workspaceId,
  role: 'admin',
  permissions: new Set(['workspace:admin']),
});

/** The workspace a SCIM bearer token belongs to, if it is current and SCIM is on. */
export async function workspaceForScimToken(db: Db, token: string) {
  const { rows } = await db.admin.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM scim_settings WHERE token_hash = $1 AND enabled',
    [scimTokenHash(token)],
  );
  return rows[0]?.workspace_id ?? null;
}

const Status = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  defaultRole: ManagedRole,
  groupRoles: z.record(z.string(), ManagedRole),
  hasToken: z.boolean(),
  users: z.number().int(),
  groups: z.number().int(),
});

async function status(ctx: CommandContext): Promise<z.infer<typeof Status>> {
  const { rows } = await ctx.tx.execute<{ enabled: boolean; default_role: Role; group_roles: Record<string, Role>; has_token: boolean }>(
    sql`SELECT enabled, default_role, group_roles, token_hash IS NOT NULL AS has_token FROM scim_settings`,
  );
  const counts = (
    await ctx.tx.execute<{ users: number; groups: number }>(
      sql`SELECT (SELECT count(*)::int FROM scim_users) AS users, (SELECT count(*)::int FROM scim_groups) AS groups`,
    )
  ).rows[0];
  const s = rows[0];
  return {
    configured: !!s,
    enabled: s?.enabled ?? false,
    defaultRole: (s?.default_role ?? 'viewer') as z.infer<typeof ManagedRole>,
    groupRoles: (s?.group_roles ?? {}) as Record<string, z.infer<typeof ManagedRole>>,
    hasToken: s?.has_token ?? false,
    users: counts.users,
    groups: counts.groups,
  };
}

export const scimStatus = defineCommand({
  name: 'scim.status',
  title: 'SCIM provisioning status',
  description: 'Whether SCIM provisioning is on, the default role, how groups map to roles, and how many people and groups it manages.',
  input: z.object({}),
  output: Status,
  permission: 'workspace:admin',
  effect: 'read',
  handler: (_i, ctx) => status(ctx),
});

export const scimConfigure = defineCommand({
  name: 'scim.configure',
  title: 'Configure SCIM provisioning',
  description:
    'Turn SCIM provisioning on or off, set the role new people get, and map identity-provider group names to roles (the highest one wins). While on, single sign-on no longer adds members by itself. Owners are never changed by SCIM.',
  input: z.object({
    enabled: z.boolean().optional(),
    defaultRole: ManagedRole.optional(),
    groupRoles: z.record(z.string().min(1).max(200), ManagedRole).optional(),
  }),
  output: Status,
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    await ctx.tx.execute(sql`
      INSERT INTO scim_settings (workspace_id, enabled, default_role, group_roles)
      VALUES (${ctx.principal.workspaceId}, ${input.enabled ?? true}, ${input.defaultRole ?? 'viewer'}, ${JSON.stringify(input.groupRoles ?? {})}::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled = coalesce(${input.enabled ?? null}, scim_settings.enabled),
        default_role = coalesce(${input.defaultRole ?? null}, scim_settings.default_role),
        group_roles = coalesce(${input.groupRoles ? JSON.stringify(input.groupRoles) : null}::jsonb, scim_settings.group_roles),
        updated_at = now()`);
    // Mappings may have changed: bring every managed person's role in line.
    const users = (await ctx.tx.execute<{ user_id: string }>(sql`SELECT user_id FROM scim_users`)).rows.map((r) => r.user_id);
    await reconcile(ctx, users);
    return status(ctx);
  },
});

export const scimRotateToken = defineCommand({
  name: 'scim.rotateToken',
  title: 'Create the SCIM token',
  description:
    'Create (or replace) the bearer token the identity provider uses for /scim/v2. It is shown once; the previous token stops working.',
  input: z.object({}),
  output: z.object({ token: z.string(), baseUrlPath: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['token'],
  handler: async (_i, ctx) => {
    const token = `scim_${randomBytes(32).toString('base64url')}`;
    await ctx.tx.execute(sql`
      INSERT INTO scim_settings (workspace_id, token_hash, token_created_at) VALUES (${ctx.principal.workspaceId}, ${scimTokenHash(token)}, now())
      ON CONFLICT (workspace_id) DO UPDATE SET token_hash = excluded.token_hash, token_created_at = now(), updated_at = now()`);
    return { token, baseUrlPath: '/scim/v2' };
  },
});

export const scimCommands = [scimStatus, scimConfigure, scimRotateToken] as const;

/** Brings members in line with SCIM: active people get the role their groups map to; inactive ones lose access. */
async function reconcile(ctx: CommandContext, userIds: string[]) {
  if (!userIds.length) return;
  const [settings] = (
    await ctx.tx.execute<{ default_role: Role; group_roles: Record<string, Role> }>(
      sql`SELECT default_role, group_roles FROM scim_settings`,
    )
  ).rows;
  const groups = (await ctx.tx.execute<{ display_name: string; members: string[] }>(sql`SELECT display_name, members FROM scim_groups`))
    .rows;
  const users = (
    await ctx.tx.execute<{ user_id: string; active: boolean; role: Role | null }>(sql`
      SELECT u.user_id, u.active, m.role FROM scim_users u
      LEFT JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = u.user_id
      WHERE u.user_id IN (${sql.join(
        userIds.map((id) => sql`${id}`),
        sql`, `,
      )})`)
  ).rows;
  const ws = ctx.principal.workspaceId;
  for (const u of users) {
    if (u.role === 'owner') continue; // owners are managed by people
    if (!u.active) {
      await ctx.tx.execute(sql`DELETE FROM workspace_members WHERE workspace_id = ${ws} AND user_id = ${u.user_id}`);
      continue;
    }
    let role: Role = settings?.default_role ?? 'viewer';
    for (const g of groups) {
      const mapped = settings?.group_roles?.[g.display_name];
      if (mapped && g.members.includes(u.user_id) && RANK[mapped] > RANK[role]) role = mapped;
    }
    await ctx.tx.execute(sql`
      INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${u.user_id}, ${role})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role WHERE workspace_members.role <> 'owner'`);
  }
}

// Internal commands, run by the /scim/v2 route as the SCIM principal (not offered to agents or the UI).

export const scimUpsertUser = defineCommand({
  name: 'scim.upsertUser',
  title: 'Provision a person (SCIM)',
  description: 'Create or update a person managed by SCIM.',
  input: z.object({ userId: z.string(), externalId: z.string().max(500).nullable(), active: z.boolean() }),
  output: z.object({ userId: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.userId,
  handler: async (input, ctx) => {
    await ctx.tx.execute(sql`
      INSERT INTO scim_users (workspace_id, user_id, external_id, active) VALUES (${ctx.principal.workspaceId}, ${input.userId}, ${input.externalId}, ${input.active})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET external_id = excluded.external_id, active = excluded.active, updated_at = now()`);
    await reconcile(ctx, [input.userId]);
    return { userId: input.userId };
  },
});

export const scimDeleteUser = defineCommand({
  name: 'scim.deleteUser',
  title: 'Deprovision a person (SCIM)',
  description: 'Remove a person from the workspace (their account stays, other workspaces are not touched).',
  input: z.object({ userId: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.userId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const role = (
      await ctx.tx.execute<{ role: Role }>(sql`SELECT role FROM workspace_members WHERE workspace_id = ${ws} AND user_id = ${input.userId}`)
    ).rows[0]?.role;
    if (role === 'owner') throw new AppError('forbidden', 'Owners are managed by people, not by SCIM.');
    await ctx.tx.execute(sql`DELETE FROM workspace_members WHERE workspace_id = ${ws} AND user_id = ${input.userId}`);
    await ctx.tx.execute(sql`DELETE FROM scim_users WHERE user_id = ${input.userId}`);
    await ctx.tx.execute(
      sql`UPDATE scim_groups SET members = array_remove(members, ${input.userId}), updated_at = now() WHERE ${input.userId} = ANY(members)`,
    );
    return { deleted: true };
  },
});

export const scimUpsertGroup = defineCommand({
  name: 'scim.upsertGroup',
  title: 'Provision a group (SCIM)',
  description: 'Create or update a group and its members; roles follow the group mapping.',
  input: z.object({
    id: z.string(),
    displayName: z.string().min(1).max(200),
    externalId: z.string().max(500).nullable(),
    members: z.array(z.string()).max(50_000),
  }),
  output: z.object({ id: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const before =
      (await ctx.tx.execute<{ members: string[] }>(sql`SELECT members FROM scim_groups WHERE id = ${input.id}`)).rows[0]?.members ?? [];
    const members = [...new Set(input.members)];
    await ctx.tx.execute(sql`
      INSERT INTO scim_groups (workspace_id, id, display_name, external_id, members)
      VALUES (${ctx.principal.workspaceId}, ${input.id}, ${input.displayName}, ${input.externalId},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(members)}::jsonb)))
      ON CONFLICT (workspace_id, id) DO UPDATE SET display_name = excluded.display_name, external_id = excluded.external_id,
        members = excluded.members, updated_at = now()`);
    await reconcile(ctx, [...new Set([...before, ...members])]);
    return { id: input.id };
  },
});

export const scimDeleteGroup = defineCommand({
  name: 'scim.deleteGroup',
  title: 'Remove a group (SCIM)',
  description: 'Remove a group; its members fall back to their other groups or the default role.',
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const before = (await ctx.tx.execute<{ members: string[] }>(sql`DELETE FROM scim_groups WHERE id = ${input.id} RETURNING members`))
      .rows[0];
    if (!before) throw new AppError('not_found', `No group ${input.id}.`);
    await reconcile(ctx, before.members);
    return { deleted: true };
  },
});
