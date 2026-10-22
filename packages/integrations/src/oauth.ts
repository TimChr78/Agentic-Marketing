import { createHash, randomBytes } from 'node:crypto';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, sha256 } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { connectorOf } from './connections';
import { type EgressPolicy, safeRequest } from './egress';

// OAuth 2.0 for connectors (Phase 8): the authorization code flow with PKCE, tokens sealed with
// the connection's secrets (under `__oauth`), and a worker that refreshes them before they expire.
// Ad platforms (Google, Meta, Microsoft) and CRMs all work this way.

declare module '@agentic-marketing/commands' {
  interface Services {
    /** This server's own URL (OAuth redirect URIs point here). */
    publicUrl?: string;
  }
}

type Row = typeof schema.connections.$inferSelect;
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
}
const PENDING_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 10 * 60_000;

export const oauthRedirectUri = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/oauth/callback`;
const stateHash = (state: string) => sha256(`oauth-state:${state}`);

async function secretsOf(tx: Tx, row: Row, kp: KeyProvider): Promise<Record<string, unknown>> {
  return row.secrets && row.secretsKeyId ? openJson(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId) : {};
}

function oauthOf(row: Row) {
  const c = connectorOf(row.connector);
  if (c.auth !== 'oauth2' || !c.oauth) throw new AppError('invalid_input', `${c.label} does not use OAuth 2.0.`);
  return c.oauth(c.settings.parse(row.settings));
}

/** Calls the token endpoint (authorization code or refresh token) and returns what to store. */
async function tokenRequest(tokenUrl: string, params: Record<string, string>, egress: EgressPolicy) {
  const res = await safeRequest(
    tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    },
    egress,
  );
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body);
  } catch {}
  if (res.status < 200 || res.status >= 300 || typeof body.access_token !== 'string')
    throw Object.assign(new Error(String(body.error_description ?? body.error ?? `HTTP ${res.status}`)), { code: body.error });
  return {
    tokens: {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.token_type === 'string' ? { tokenType: body.token_type } : {}),
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    } satisfies OAuthTokens,
    expiresAt:
      typeof body.expires_in === 'number' || typeof body.expires_in === 'string'
        ? new Date(Date.now() + Number(body.expires_in) * 1000)
        : null,
  };
}

async function storeTokens(tx: Tx, row: Row, kp: KeyProvider, tokens: OAuthTokens, expiresAt: Date | null) {
  const current = await secretsOf(tx, row, kp);
  const previous = (current.__oauth ?? {}) as Partial<OAuthTokens>;
  // Providers often send a refresh token only the first time: keep the one we have.
  const merged = { ...current, __oauth: { ...tokens, refreshToken: tokens.refreshToken ?? previous.refreshToken } };
  const sealed = await sealJson(tx, row.workspaceId, kp, merged);
  await tx
    .update(schema.connections)
    .set({
      secrets: sealed.blob,
      secretsKeyId: sealed.keyId,
      oauthStatus: 'connected',
      oauthError: null,
      oauthPending: null,
      tokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.connections.id, row.id));
}

/** The connection's access token, for actions. */
export function accessTokenOf(secrets: Record<string, unknown>): string | undefined {
  return (secrets.__oauth as Partial<OAuthTokens> | undefined)?.accessToken;
}

export const authorizeConnection = defineCommand({
  name: 'connections.authorize',
  title: 'Connect an OAuth 2.0 connection',
  description:
    'Starts the OAuth 2.0 authorization for a connection: open the returned URL in a browser, sign in at the provider and allow access. The connection is connected when the provider sends you back.',
  input: z.object({ id: z.string().regex(/^con_[0-9a-f]{32}$/) }),
  output: z.object({ url: z.string(), redirectUri: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.connections).where(eq(schema.connections.id, input.id));
    if (!row) throw new AppError('not_found', `No connection ${input.id}.`);
    const o = oauthOf(row);
    const secrets = await secretsOf(ctx.tx, row, ctx.services.keyProvider);
    if (typeof secrets.clientId !== 'string')
      throw new AppError('conflict', 'Set the client id and secret of your app first (connections.update).');
    const redirectUri = oauthRedirectUri(ctx.services.publicUrl ?? '');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await ctx.tx
      .update(schema.connections)
      .set({
        oauthStatus: row.oauthStatus === 'connected' ? 'connected' : 'pending',
        oauthPending: { stateHash: stateHash(state), verifier, redirectUri, at: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, row.id));
    const url = new URL(o.authorizeUrl);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: secrets.clientId,
      redirect_uri: redirectUri,
      scope: o.scopes.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(o.params ?? {}),
    }))
      if (v) url.searchParams.set(k, v);
    return { url: url.toString(), redirectUri };
  },
});

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:Canvas;color:CanvasText}main{max-width:420px;margin:0 auto}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** GET /oauth/callback: the provider sends the person back here with a code. */
export function oauthRoutes(deps: { db: Db; kp: KeyProvider; egress: EgressPolicy }) {
  const app = new Hono();
  app.get('/oauth/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
      `SELECT workspace_id, id FROM connections WHERE oauth_pending ->> 'stateHash' = $1`,
      [stateHash(state)],
    );
    if (!state || !rows[0]) return c.html(page('Link expired', 'Start connecting again from the platform.'), 400);
    const { workspace_id: ws, id } = rows[0];
    const result = await deps.db.withWorkspace(ws, async (tx) => {
      const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id));
      const pending = row?.oauthPending;
      if (!row || !pending || Date.now() - Date.parse(pending.at) > PENDING_MS)
        return { ok: false, text: 'This link has expired. Start connecting again.' };
      const fail = async (why: string) => {
        await tx
          .update(schema.connections)
          .set({ oauthStatus: 'error', oauthError: why, oauthPending: null })
          .where(eq(schema.connections.id, id));
        return { ok: false, text: `The provider did not allow access: ${escapeHtml(why)}` };
      };
      if (c.req.query('error')) return fail(c.req.query('error_description') ?? c.req.query('error') ?? 'denied');
      const secrets = await secretsOf(tx, row, deps.kp);
      try {
        const { tokens, expiresAt } = await tokenRequest(
          oauthOf(row).tokenUrl,
          {
            grant_type: 'authorization_code',
            code: c.req.query('code') ?? '',
            redirect_uri: pending.redirectUri,
            client_id: String(secrets.clientId ?? ''),
            client_secret: String(secrets.clientSecret ?? ''),
            code_verifier: pending.verifier,
          },
          deps.egress,
        );
        await storeTokens(tx, row, deps.kp, tokens, expiresAt);
        return { ok: true, text: `${escapeHtml(row.name)} is connected. You can close this window.` };
      } catch (err) {
        return fail((err as Error).message);
      }
    });
    return c.html(page(result.ok ? 'Connected' : 'Not connected', result.text), result.ok ? 200 : 400);
  });
  return app;
}

/** Refreshes one connection's tokens; marks it as needing a reconnect when the refresh token is refused. */
export async function refreshConnection(db: Db, ws: string, id: string, deps: { kp: KeyProvider; egress: EgressPolicy }) {
  await db.withWorkspace(ws, async (tx) => {
    const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id));
    if (row?.oauthStatus !== 'connected') return;
    const secrets = await secretsOf(tx, row, deps.kp);
    const refreshToken = (secrets.__oauth as Partial<OAuthTokens> | undefined)?.refreshToken;
    const markError = (why: string) =>
      tx
        .update(schema.connections)
        .set({ oauthStatus: 'error', oauthError: why, updatedAt: new Date() })
        .where(eq(schema.connections.id, id));
    if (!refreshToken) return markError('the access token expired and there is no refresh token: connect again');
    try {
      const { tokens, expiresAt } = await tokenRequest(
        oauthOf(row).tokenUrl,
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: String(secrets.clientId ?? ''),
          client_secret: String(secrets.clientSecret ?? ''),
        },
        deps.egress,
      );
      await storeTokens(tx, row, deps.kp, tokens, expiresAt);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // invalid_grant: revoked or expired for good. Anything else is retried on the next round.
      if (code === 'invalid_grant') await markError(`the provider refused the refresh token: connect again (${(err as Error).message})`);
      else logger.warn({ err, connection: id }, 'OAuth token refresh failed; will retry');
    }
  });
}

/** Refreshes tokens that expire within ten minutes, every minute. */
export async function runTokenRefresher(deps: { db: Db; kp: KeyProvider; egress: EgressPolicy }, signal: AbortSignal, tickMs = 60_000) {
  while (!signal.aborted) {
    try {
      const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
        `SELECT workspace_id, id FROM connections WHERE oauth_status = 'connected' AND enabled AND token_expires_at < $1 LIMIT 100`,
        [new Date(Date.now() + REFRESH_MARGIN_MS)],
      );
      for (const r of rows) await refreshConnection(deps.db, r.workspace_id, r.id, deps);
    } catch (err) {
      logger.error({ err }, 'token refresh round failed');
    }
    await new Promise<void>((r) => {
      const timer = setTimeout(r, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
}

export const oauthCommands = [authorizeConnection] as const;
