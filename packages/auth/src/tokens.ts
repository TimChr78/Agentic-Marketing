import { randomBytes } from 'node:crypto';
import {
  agentPrincipal,
  type CommandContext,
  defineCommand,
  PERMISSIONS,
  type Permission,
  type Principal,
  ROLE_PERMISSIONS,
} from '@agentic-marketing/commands';
import { AppError, newId, sha256 } from '@agentic-marketing/core';
import { type Db, type Role, schema } from '@agentic-marketing/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

// API tokens for scripts and automation tools (n8n, Activepieces, cron jobs) that cannot do an
// OAuth flow. A token acts as an agent for the person who made it: their current role's
// permissions intersected with the scopes chosen for the token. Shown once; only a hash is kept.

export const TOKEN_PREFIX = 'amk_';
export const apiTokenHash = (token: string) => sha256(`api-token:${token}`);

const Token = z.object({
  id: z.string(),
  name: z.string(),
  userId: z.string(),
  ownerName: z.string(),
  tokenHint: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
});
const tokenOut = (r: typeof schema.apiTokens.$inferSelect, ownerName: string) => ({
  id: r.id,
  name: r.name,
  userId: r.userId,
  ownerName,
  tokenHint: r.tokenHint,
  scopes: r.scopes,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revoked: !!r.revokedAt,
});

const Owner = z.object({ id: z.string(), name: z.string(), email: z.string() });
const TokenChange = z.record(z.string(), z.unknown());
const HistoryEntry = z.object({
  at: z.string(),
  by: z.object({ id: z.string(), name: z.string() }),
  changes: TokenChange,
  steppedUp: z.boolean(),
});

async function ownerNames(ctx: CommandContext, userIds: string[]) {
  if (!userIds.length) return new Map<string, string>();
  const people = await ctx.services.directory.users([...new Set(userIds)]);
  return new Map([...people].map(([id, p]) => [id, p.name || p.email || id]));
}

async function ownerName(ctx: CommandContext, userId: string): Promise<string> {
  return (await ownerNames(ctx, [userId])).get(userId) ?? userId;
}

/** The scopes a role may grant, in the same words as apiTokens.create. */
function assertEditorScopes(role: Role, scopes: string[]) {
  const allowed = ROLE_PERMISSIONS[role];
  const extra = scopes.filter((s) => !allowed.includes(s as Permission));
  if (extra.length) throw new AppError('forbidden', `Your role (${role}) cannot grant ${extra.join(', ')}.`);
}

/** The actions a permission grants, for the step-up message. */
const PERMISSION_ACTIONS: Record<Permission, string> = {
  'artifacts:read': 'read artifacts',
  'artifacts:write': 'draft and edit artifacts',
  'artifacts:publish': 'submit changes for review',
  'artifacts:approve': 'approve changes',
  'messages:send': 'send e-mails',
  'audit:read': 'read the audit log',
  'profiles:read': 'read profiles',
  'profiles:pii': 'see personal data',
  'profiles:write': 'edit profiles',
  'profiles:erase': "erase people's data",
  'secrets:read': 'use stored secrets',
  'secrets:write': 'change stored secrets',
  'workspace:admin': 'manage workspace settings and members',
};

function actionsText(permissions: string[]): string {
  const actions = permissions.map((p) => PERMISSION_ACTIONS[p as Permission] ?? p);
  if (actions.length <= 1) return actions[0] ?? '';
  return `${actions.slice(0, -1).join(', ')} and ${actions.at(-1)}`;
}

/** Explains a widening in plain language before asking for the password. */
function wideningText(added: string[], expiryExtended: boolean, newExpiresAt: Date | null): string {
  const parts: string[] = [];
  if (added.length) parts.push(`Adding ${added.join(', ')} lets this token ${actionsText(added)}.`);
  if (expiryExtended)
    parts.push(
      newExpiresAt
        ? 'Extending the expiry lets this token keep working for longer.'
        : 'Removing the expiry lets this token keep working indefinitely.',
    );
  return parts.join(' ');
}

const expiryWidens = (before: Date | null, after: Date | null) => !!before && (!after || after.getTime() > before.getTime());

async function tokenHistory(ctx: CommandContext, tokenId: string, extraUserIds: string[] = []) {
  const rows = await ctx.tx
    .select()
    .from(schema.apiTokenChanges)
    .where(eq(schema.apiTokenChanges.tokenId, tokenId))
    .orderBy(desc(schema.apiTokenChanges.changedAt));
  const people = await ctx.services.directory.users([...new Set([...rows.map((r) => r.changedBy), ...extraUserIds])]);
  return rows.map((r) => ({
    at: r.changedAt.toISOString(),
    by: { id: r.changedBy, name: people.get(r.changedBy)?.name || people.get(r.changedBy)?.email || r.changedBy },
    changes: r.changes,
    steppedUp: r.steppedUp,
  }));
}

export const createApiToken = defineCommand({
  name: 'apiTokens.create',
  title: 'Create an API token',
  description:
    'A token for scripts and automation tools (Authorization: Bearer amk_…), acting as an agent for you with the scopes you choose (never more than your role allows). Shown once.',
  input: z.object({
    name: z.string().min(1).max(120).describe('What uses it, e.g. "n8n"'),
    scopes: z.array(z.enum(PERMISSIONS)).min(1),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  }),
  output: Token.extend({ token: z.string() }),
  permission: null,
  effect: 'write',
  humansOnly: true,
  sensitiveOutput: ['token'],
  handler: async (input, ctx) => {
    assertEditorScopes(ctx.principal.role, input.scopes);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const scopes = [...new Set(input.scopes)];
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const [row] = await ctx.tx
      .insert(schema.apiTokens)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('tok'),
        userId: ctx.principal.userId,
        name: input.name,
        tokenHash: apiTokenHash(token),
        tokenHint: `${token.slice(0, 8)}…${token.slice(-4)}`,
        scopes,
        expiresAt,
      })
      .returning();
    await ctx.tx.insert(schema.apiTokenChanges).values({
      workspaceId: ctx.principal.workspaceId,
      id: newId('tch'),
      tokenId: row.id,
      changedBy: ctx.principal.userId,
      changes: { created: { name: row.name, scopes: row.scopes, expiresAt: expiresAt?.toISOString() ?? null } },
    });
    return { ...tokenOut(row, await ownerName(ctx, row.userId)), token };
  },
});

export const listApiTokens = defineCommand({
  name: 'apiTokens.list',
  title: 'List API tokens',
  description: 'Your API tokens (admins: everyone’s), with scopes and last use. Token values are never shown again.',
  input: z.object({}),
  output: z.object({ tokens: z.array(Token) }),
  permission: null,
  effect: 'read',
  handler: async (_input, ctx) => {
    const all = ctx.principal.permissions.has('workspace:admin');
    const rows = await ctx.tx
      .select()
      .from(schema.apiTokens)
      .where(all ? undefined : eq(schema.apiTokens.userId, ctx.principal.userId))
      .orderBy(desc(schema.apiTokens.createdAt));
    const names = await ownerNames(
      ctx,
      rows.map((r) => r.userId),
    );
    return { tokens: rows.map((r) => tokenOut(r, names.get(r.userId) ?? r.userId)) };
  },
});

export const getApiToken = defineCommand({
  name: 'apiTokens.get',
  title: 'Get an API token',
  description:
    'A token with its owner, last use and change history (newest first). Your own tokens, or anyone’s for admins. The token value is never shown again.',
  input: z.object({ id: z.string().regex(/^tok_[0-9a-f]{32}$/) }),
  output: Token.extend({ owner: Owner, history: z.array(HistoryEntry) }),
  permission: null,
  effect: 'read',
  handler: async (input, ctx) => {
    const [row] = await ctx.tx
      .select()
      .from(schema.apiTokens)
      .where(
        and(
          eq(schema.apiTokens.id, input.id),
          ctx.principal.permissions.has('workspace:admin') ? undefined : eq(schema.apiTokens.userId, ctx.principal.userId),
        ),
      );
    if (!row) throw new AppError('not_found', `No token ${input.id} you can see.`);
    const people = await ctx.services.directory.users([row.userId]);
    const owner = people.get(row.userId);
    return {
      ...tokenOut(row, owner?.name || owner?.email || row.userId),
      owner: { id: row.userId, name: owner?.name ?? '', email: owner?.email ?? '' },
      history: await tokenHistory(ctx, row.id, [row.userId]),
    };
  },
});

export const updateApiToken = defineCommand({
  name: 'apiTokens.update',
  title: 'Edit an API token',
  description:
    'Change a token’s name, scopes or expiry. A token acts with its owner’s current role intersected with its scopes, so it never has more than the owner’s role allows. Removing scopes, renaming and shortening the expiry apply at once; adding scopes or extending the expiry needs your password, because it widens what the token can do.',
  input: z.object({
    id: z.string().regex(/^tok_[0-9a-f]{32}$/),
    name: z.string().min(1).max(120).optional(),
    scopes: z.array(z.enum(PERMISSIONS)).min(1).optional(),
    expiresAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe('When the token stops working; null means never. Extending it needs your password.'),
    password: z.string().min(1).optional().describe('Your current password, to confirm a widening change'),
  }),
  output: Token.extend({ added: z.array(z.string()), removed: z.array(z.string()), steppedUp: z.boolean() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  sensitive: ['password'],
  target: (i) => i.id,
  handler: async (input, ctx) => {
    if (input.name === undefined && input.scopes === undefined && input.expiresAt === undefined)
      throw new AppError('invalid_input', 'Pass at least one of name, scopes or expiresAt to change.');
    const [token] = await ctx.tx.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, input.id));
    if (!token) throw new AppError('not_found', `No token ${input.id} in this workspace. List tokens with apiTokens.list.`);
    if (token.revokedAt) throw new AppError('conflict', `Token ${input.id} was revoked and cannot be edited. Create a new token instead.`);

    const newScopes = input.scopes ? [...new Set(input.scopes)] : token.scopes;
    const added = input.scopes ? newScopes.filter((s) => !token.scopes.includes(s)) : [];
    const removed = input.scopes ? token.scopes.filter((s) => !newScopes.includes(s)) : [];
    if (input.scopes) {
      assertEditorScopes(ctx.principal.role, newScopes);
      const [owner] = await ctx.tx
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceMembers.userId, token.userId)));
      if (!owner)
        throw new AppError(
          'conflict',
          'This token’s owner is no longer a member of this workspace, so its scopes cannot be changed. Revoke it instead.',
        );
      const extra = newScopes.filter((s) => !ROLE_PERMISSIONS[owner.role].includes(s as Permission));
      if (extra.length)
        throw new AppError(
          'forbidden',
          `This token’s owner has the ${owner.role} role, which cannot grant ${extra.join(', ')}. A token never has more than its owner’s role allows.`,
        );
    }

    const newExpiresAt = input.expiresAt === undefined ? token.expiresAt : input.expiresAt === null ? null : new Date(input.expiresAt);
    const expiryChanged = (token.expiresAt?.getTime() ?? null) !== (newExpiresAt?.getTime() ?? null);
    const expiryExpanded = expiryChanged && expiryWidens(token.expiresAt, newExpiresAt);
    const widening = added.length > 0 || expiryExpanded;
    let steppedUp = false;
    if (widening) {
      const reason = wideningText(added, expiryExpanded, newExpiresAt);
      if (!input.password) {
        const state = await ctx.services.directory.verifyPassword(ctx.principal.userId, '');
        if (state === 'no_password')
          throw new AppError(
            'forbidden',
            `${reason} You sign in with single sign-on, so there is no password to confirm with. Ask another admin with a password to make this change.`,
          );
        throw new AppError('forbidden', `${reason} Confirm with your password to widen it.`);
      }
      // Token widening is a password check like sign-in, so it needs the same kind of limit (#61).
      const limiter = ctx.services.stepUpLimiter;
      const blockedUntil = await limiter?.lockedUntil(ctx.principal.userId);
      if (blockedUntil) {
        const minutes = Math.max(1, Math.ceil((blockedUntil.getTime() - Date.now()) / 60_000));
        throw new AppError(
          'forbidden',
          `Too many incorrect password attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} (after ${blockedUntil.toISOString()}).`,
        );
      }
      const state = await ctx.services.directory.verifyPassword(ctx.principal.userId, input.password);
      if (state === 'no_password')
        throw new AppError(
          'forbidden',
          'You sign in with single sign-on, so there is no password to confirm widening this token. Ask another admin with a password to make this change.',
        );
      if (state === 'wrong') {
        await limiter?.recordFailure(ctx.principal.userId);
        throw new AppError('forbidden', 'The password is not correct.');
      }
      // A correct password clears earlier failures so one typo does not count towards a later lockout.
      await limiter?.reset(ctx.principal.userId);
      steppedUp = true;
    }

    const nameChanged = input.name !== undefined && input.name !== token.name;
    const scopesChanged = added.length > 0 || removed.length > 0;
    const patch: { name?: string; scopes?: string[]; expiresAt?: Date | null } = {};
    if (nameChanged) patch.name = input.name;
    if (input.scopes && scopesChanged) patch.scopes = newScopes;
    if (expiryChanged) patch.expiresAt = newExpiresAt;
    let row = token;
    if (Object.keys(patch).length)
      [row] = await ctx.tx.update(schema.apiTokens).set(patch).where(eq(schema.apiTokens.id, token.id)).returning();

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (nameChanged) changes.name = { from: token.name, to: input.name };
    if (input.scopes && scopesChanged) changes.scopes = { from: token.scopes, to: newScopes };
    if (expiryChanged) changes.expiresAt = { from: token.expiresAt?.toISOString() ?? null, to: newExpiresAt?.toISOString() ?? null };
    if (Object.keys(changes).length)
      await ctx.tx.insert(schema.apiTokenChanges).values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('tch'),
        tokenId: token.id,
        changedBy: ctx.principal.userId,
        changes,
        steppedUp,
      });

    return {
      ...tokenOut(row, await ownerName(ctx, row.userId)),
      added,
      removed,
      steppedUp,
    };
  },
});

export const revokeApiToken = defineCommand({
  name: 'apiTokens.revoke',
  title: 'Revoke an API token',
  description: 'Stop a token from working, at once. Your own tokens, or anyone’s for admins.',
  input: z.object({ id: z.string().regex(/^tok_[0-9a-f]{32}$/) }),
  output: z.object({ revoked: z.literal(true) }),
  permission: null,
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const all = ctx.principal.permissions.has('workspace:admin');
    const res = await ctx.tx
      .update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiTokens.id, input.id),
          isNull(schema.apiTokens.revokedAt),
          all ? undefined : eq(schema.apiTokens.userId, ctx.principal.userId),
        ),
      )
      .returning({ id: schema.apiTokens.id });
    if (!res.length) throw new AppError('not_found', `No active token ${input.id} you can revoke.`);
    await ctx.tx.insert(schema.apiTokenChanges).values({
      workspaceId: ctx.principal.workspaceId,
      id: newId('tch'),
      tokenId: input.id,
      changedBy: ctx.principal.userId,
      changes: { revoked: true },
    });
    return { revoked: true as const };
  },
});

export const tokenCommands = [createApiToken, listApiTokens, getApiToken, updateApiToken, revokeApiToken] as const;

/**
 * The principal of a Bearer API token, or null when it is unknown, revoked, expired or its owner
 * left the workspace. The row is read on every request and never cached: narrowing a token's
 * scopes takes effect on the very next REST or MCP call.
 */
export async function principalFromApiToken(db: Db, token: string): Promise<Principal | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const { rows } = await db.admin.query<{
    workspace_id: string;
    id: string;
    user_id: string;
    scopes: string[];
    expires_at: Date | null;
    revoked_at: Date | null;
    last_used_at: Date | null;
    role: Role | null;
  }>(
    `SELECT t.workspace_id, t.id, t.user_id, t.scopes, t.expires_at, t.revoked_at, t.last_used_at, m.role
     FROM api_tokens t LEFT JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
     WHERE t.token_hash = $1`,
    [apiTokenHash(token)],
  );
  const t = rows[0];
  if (!t?.role || t.revoked_at || (t.expires_at && t.expires_at < new Date())) return null;
  if (!t.last_used_at || Date.now() - t.last_used_at.getTime() > 60_000)
    await db.admin.query('UPDATE api_tokens SET last_used_at = now() WHERE workspace_id = $1 AND id = $2', [t.workspace_id, t.id]);
  return agentPrincipal(t.user_id, `token:${t.id}`, t.workspace_id, t.role, t.scopes);
}
