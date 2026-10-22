import { randomBytes } from 'node:crypto';
import { agentPrincipal, defineCommand, PERMISSIONS, type Principal, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
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
  tokenHint: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
});
const tokenOut = (r: typeof schema.apiTokens.$inferSelect) => ({
  id: r.id,
  name: r.name,
  userId: r.userId,
  tokenHint: r.tokenHint,
  scopes: r.scopes,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revoked: !!r.revokedAt,
});

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
    const allowed = ROLE_PERMISSIONS[ctx.principal.role];
    const extra = input.scopes.filter((s) => !allowed.includes(s));
    if (extra.length) throw new AppError('forbidden', `Your role (${ctx.principal.role}) cannot grant ${extra.join(', ')}.`);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const [row] = await ctx.tx
      .insert(schema.apiTokens)
      .values({
        workspaceId: ctx.principal.workspaceId,
        id: newId('tok'),
        userId: ctx.principal.userId,
        name: input.name,
        tokenHash: apiTokenHash(token),
        tokenHint: `${token.slice(0, 8)}…${token.slice(-4)}`,
        scopes: [...new Set(input.scopes)],
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning();
    return { ...tokenOut(row), token };
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
    return { tokens: rows.map(tokenOut) };
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
    return { revoked: true as const };
  },
});

export const tokenCommands = [createApiToken, listApiTokens, revokeApiToken] as const;

/** The principal of a Bearer API token, or null when it is unknown, revoked, expired or its owner left the workspace. */
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
