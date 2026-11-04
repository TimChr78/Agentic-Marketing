import { createHash, randomBytes } from 'node:crypto';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, sha256 } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { type KeyProvider, openJson, sealJson } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { connectorOf } from './connections';
import { type EgressPolicy, type SafeResponse, safeRequest } from './egress';

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
/** One replica may refresh one connection at a time; the token exchange itself is bounded at 10 s. */
const REFRESH_LEASE_MS = 2 * 60_000;

export const oauthRedirectUri = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/oauth/callback`;
const stateHash = (state: string) => sha256(`oauth-state:${state}`);

/** The HTTP seam; tests pass a deterministic delayed/failing exchange instead of a real provider. */
export type OAuthRequest = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number },
  egress: EgressPolicy,
) => Promise<SafeResponse>;

export interface OAuthDeps {
  db: Db;
  kp: KeyProvider;
  egress: EgressPolicy;
  /** Defaults to the guarded network request. */
  http?: OAuthRequest;
}

async function secretsOf(tx: Tx, row: Row, kp: KeyProvider): Promise<Record<string, unknown>> {
  return row.secrets && row.secretsKeyId ? openJson(tx, row.workspaceId, kp, row.secrets, row.secretsKeyId) : {};
}

function oauthOf(row: Row) {
  const c = connectorOf(row.connector);
  if (c.auth !== 'oauth2' || !c.oauth) throw new AppError('invalid_input', `${c.label} does not use OAuth 2.0.`);
  return c.oauth(c.settings.parse(row.settings));
}

/** Calls the token endpoint (authorization code or refresh token) and returns what to store. */
async function tokenRequest(tokenUrl: string, params: Record<string, string>, egress: EgressPolicy, request: OAuthRequest = safeRequest) {
  const res = await request(
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
      oauthRefreshLeaseUntil: null,
      oauthRefreshLeaseToken: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.connections.id, row.id));
}

/** Whether the stored authorization changed since a refresh read it (re-authorization or a winner). */
function oauthStateChanged(
  current: Record<string, unknown>,
  read: Record<string, unknown>,
  currentExpiry: Date | null,
  readExpiry: Date | null,
) {
  const before = (read.__oauth ?? {}) as Partial<OAuthTokens>;
  const after = (current.__oauth ?? {}) as Partial<OAuthTokens>;
  return (
    before.accessToken !== after.accessToken ||
    before.refreshToken !== after.refreshToken ||
    (currentExpiry?.getTime() ?? null) !== (readExpiry?.getTime() ?? null)
  );
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

type CallbackResult = { ok: boolean; text: string };

/**
 * GET /oauth/callback: the provider sends the person back here with a code.
 *
 * The authorization state is consumed in a short transaction, then the code-for-token exchange
 * runs with no database transaction or pooled connection held (#375). A second short transaction
 * stores the result only while this exact authorization is still current: a newer `authorize`
 * attempt replaces `oauthPending`, and a deleted or disabled connection is never overwritten.
 */
export function oauthRoutes(deps: OAuthDeps) {
  const app = new Hono();
  app.get('/oauth/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    if (!state) return c.html(page('Link expired', 'Start connecting again from the platform.'), 400);
    const hash = stateHash(state);
    const { rows } = await deps.db.admin.query<{ workspace_id: string; id: string }>(
      `SELECT workspace_id, id FROM connections WHERE oauth_pending ->> 'stateHash' = $1`,
      [hash],
    );
    if (!rows[0]) return c.html(page('Link expired', 'Start connecting again from the platform.'), 400);
    const { workspace_id: ws, id } = rows[0];

    // 1. Validate and consume the one-time state atomically. Nothing leaves the database first.
    const prepared = await deps.db.withWorkspace(ws, async (tx) => {
      const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
      const pending = row?.oauthPending;
      if (!row || !row.enabled) return { ok: false as const, text: 'This connection was deleted or disabled. Nothing was connected.' };
      if (!pending || pending.stateHash !== hash) return { ok: false as const, text: 'This link has expired. Start connecting again.' };
      if (Date.now() - Date.parse(pending.at) > PENDING_MS || (pending as { consumedAt?: string }).consumedAt)
        return { ok: false as const, text: 'This link has expired. Start connecting again.' };
      const oauth = oauthOf(row);
      const secrets = await secretsOf(tx, row, deps.kp);
      if (c.req.query('error')) {
        const why = c.req.query('error_description') ?? c.req.query('error') ?? 'denied';
        await tx
          .update(schema.connections)
          .set({ oauthStatus: 'error', oauthError: why, oauthPending: null, updatedAt: new Date() })
          .where(eq(schema.connections.id, id));
        return { ok: false as const, text: `The provider did not allow access: ${escapeHtml(why)}` };
      }
      // One-time: mark this state consumed before the network call. A replay finds the marker.
      await tx
        .update(schema.connections)
        .set({
          oauthPending: { ...pending, consumedAt: new Date().toISOString() },
          updatedAt: new Date(),
        })
        .where(eq(schema.connections.id, id));
      return { ok: true as const, row, pending, oauth, secrets: secrets as Record<string, unknown> };
    });
    if (!prepared.ok) return c.html(page('Not connected', escapeHtml(prepared.text)), 400);

    // 2. Exchange the code outside every transaction. A slow provider must not pin the app pool.
    let exchanged: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      exchanged = await tokenRequest(
        prepared.oauth.tokenUrl,
        {
          grant_type: 'authorization_code',
          code: c.req.query('code') ?? '',
          redirect_uri: prepared.pending.redirectUri,
          client_id: String(prepared.secrets.clientId ?? ''),
          client_secret: String(prepared.secrets.clientSecret ?? ''),
          code_verifier: prepared.pending.verifier,
        },
        deps.egress,
        deps.http,
      );
    } catch (err) {
      const why = (err as Error).message;
      const result = await deps.db.withWorkspace(ws, async (tx) => {
        const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
        if (!row || !row.enabled) return { ok: false, text: 'This connection was deleted or disabled. Nothing was connected.' };
        // The authorization was replaced or completed by a newer callback: leave it alone.
        if (!row.oauthPending || row.oauthPending.stateHash !== hash || !(row.oauthPending as { consumedAt?: string }).consumedAt)
          return { ok: false, text: 'A newer authorization replaced this one. Start connecting again.' };
        await tx
          .update(schema.connections)
          .set({ oauthStatus: 'error', oauthError: why, oauthPending: null, updatedAt: new Date() })
          .where(eq(schema.connections.id, id));
        return { ok: false, text: `The provider did not allow access: ${escapeHtml(why)}` };
      });
      return c.html(page('Not connected', result.text), 400);
    }

    // 3. Persist only if this exact authorization is still the current one.
    const result = await deps.db.withWorkspace(ws, async (tx): Promise<CallbackResult> => {
      const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
      if (!row || !row.enabled) return { ok: false, text: 'This connection was deleted or disabled. Nothing was connected.' };
      if (!row.oauthPending || row.oauthPending.stateHash !== hash || !(row.oauthPending as { consumedAt?: string }).consumedAt)
        return { ok: false, text: 'A newer authorization replaced this one. Start connecting again.' };
      await storeTokens(tx, row, deps.kp, exchanged.tokens, exchanged.expiresAt);
      return { ok: true, text: `${escapeHtml(row.name)} is connected. You can close this window.` };
    });
    return c.html(page(result.ok ? 'Connected' : 'Not connected', result.text), result.ok ? 200 : 400);
  });
  return app;
}

interface RefreshClaim {
  row: Row;
  secrets: Record<string, unknown>;
  leaseToken: string;
}

/**
 * Claims the refresh lease in a short transaction and reads the latest row/secrets (#376).
 * Null means another replica holds the lease, the connection is no longer eligible, or it was
 * refreshed between the scheduler's query and this claim.
 */
async function claimRefresh(deps: OAuthDeps, ws: string, id: string, force = false): Promise<RefreshClaim | null> {
  return deps.db.withWorkspace(ws, async (tx) => {
    const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
    if (!row || !row.enabled || row.oauthStatus !== 'connected') return null;
    const now = Date.now();
    if (row.oauthRefreshLeaseUntil && row.oauthRefreshLeaseUntil.getTime() > now) return null;
    if (!force && (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() > now + REFRESH_MARGIN_MS)) return null;
    const leaseToken = randomBytes(16).toString('hex');
    const [claimed] = await tx
      .update(schema.connections)
      .set({
        oauthRefreshLeaseUntil: new Date(now + REFRESH_LEASE_MS),
        oauthRefreshLeaseToken: leaseToken,
        updatedAt: new Date(now),
      })
      .where(eq(schema.connections.id, id))
      .returning();
    return { row: claimed, secrets: await secretsOf(tx, claimed, deps.kp), leaseToken };
  });
}

async function releaseRefreshLease(deps: OAuthDeps, ws: string, id: string, leaseToken: string) {
  await deps.db
    .withWorkspace(ws, (tx) =>
      tx
        .update(schema.connections)
        .set({ oauthRefreshLeaseUntil: null, oauthRefreshLeaseToken: null })
        .where(and(eq(schema.connections.id, id), eq(schema.connections.oauthRefreshLeaseToken, leaseToken))),
    )
    .catch((err) => logger.warn({ err, connection: id }, 'OAuth refresh lease could not be released'));
}

/** The failure is only ours if nobody refreshed or re-authorized the connection meanwhile. */
function stillOwnsRefresh(claim: RefreshClaim, row: Row, secrets: Record<string, unknown>) {
  return (
    row.oauthRefreshLeaseToken === claim.leaseToken &&
    !oauthStateChanged(secrets, claim.secrets, row.tokenExpiresAt, claim.row.tokenExpiresAt)
  );
}

/**
 * Refreshes one connection's tokens; marks it as needing a reconnect when the refresh token is
 * refused. The lease is committed before the HTTP exchange and the write-back re-reads the row, so
 * two replicas never redeem the same rotating refresh token and a stale `invalid_grant` cannot
 * overwrite a newer valid authorization (#376).
 */
export async function refreshConnection(db: Db, ws: string, id: string, deps: OAuthDeps, opts: { force?: boolean } = {}) {
  const claim = await claimRefresh(deps, ws, id, opts.force);
  if (!claim) return;
  const refreshToken = (claim.secrets.__oauth as Partial<OAuthTokens> | undefined)?.refreshToken;
  try {
    if (!refreshToken) {
      await db.withWorkspace(ws, async (tx) => {
        const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
        if (!row || !row.enabled || row.oauthStatus !== 'connected') return;
        const current = await secretsOf(tx, row, deps.kp);
        if (!stillOwnsRefresh(claim, row, current)) return;
        await tx
          .update(schema.connections)
          .set({
            oauthStatus: 'error',
            oauthError: 'the access token expired and there is no refresh token: connect again',
            oauthRefreshLeaseUntil: null,
            oauthRefreshLeaseToken: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.connections.id, id));
      });
      return;
    }
    const { tokens, expiresAt } = await tokenRequest(
      oauthOf(claim.row).tokenUrl,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: String(claim.secrets.clientId ?? ''),
        client_secret: String(claim.secrets.clientSecret ?? ''),
      },
      deps.egress,
      deps.http,
    );
    await db.withWorkspace(ws, async (tx) => {
      const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
      if (!row || !row.enabled || row.oauthStatus !== 'connected') return;
      const current = await secretsOf(tx, row, deps.kp);
      // The winner already stored newer tokens, or the person re-authorized: discard this result.
      if (!stillOwnsRefresh(claim, row, current)) return;
      await storeTokens(tx, row, deps.kp, tokens, expiresAt);
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // invalid_grant: revoked or expired for good. Anything else is retried on the next round.
    if (code !== 'invalid_grant') {
      logger.warn({ err, connection: id }, 'OAuth token refresh failed; will retry');
      return;
    }
    await db.withWorkspace(ws, async (tx) => {
      const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, id)).for('update');
      if (!row || !row.enabled || row.oauthStatus !== 'connected') return;
      const current = await secretsOf(tx, row, deps.kp);
      // A concurrent winner or a fresh authorization landed after our read: this rejection is
      // stale and must not brick the connection.
      if (!stillOwnsRefresh(claim, row, current)) {
        logger.info({ connection: id }, 'ignored a stale OAuth invalid_grant');
        return;
      }
      await tx
        .update(schema.connections)
        .set({
          oauthStatus: 'error',
          oauthError: `the provider refused the refresh token: connect again (${(err as Error).message})`,
          oauthRefreshLeaseUntil: null,
          oauthRefreshLeaseToken: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.connections.id, id));
    });
  } finally {
    await releaseRefreshLease(deps, ws, id, claim.leaseToken);
  }
}

/** Refreshes tokens that expire within ten minutes, every minute. */
export async function runTokenRefresher(deps: OAuthDeps, signal: AbortSignal, tickMs = 60_000) {
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
