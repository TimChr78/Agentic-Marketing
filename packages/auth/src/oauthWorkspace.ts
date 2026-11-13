import { AsyncLocalStorage } from 'node:async_hooks';
import { PERMISSIONS, type Permission, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { AppError, sha256 } from '@agentic-marketing/core';
import type { Db, Role } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';

// One brand per OAuth connection (#187). The consent page writes the chosen workspace for the
// pending authorization; the OAuth provider reads it as the grant's reference id, and the issued
// access token carries it as the `workspace_id` claim. The selection only records a pending
// choice; the membership and role check here decides whether the person may make it.
//
// The choice is bound to the exact authorization request, not to the session (#456): two consent
// tabs for two clients share one session, so a session-wide value let one tab bind the other
// tab's brand. The request key is derived from the authorization request's stable parameters
// (`client_id`, `redirect_uri`, `state`, `code_challenge`), which survive the redirect from
// `/authorize` to the consent page and its signed query.

export interface OAuthWorkspaceChoice {
  id: string;
  name: string;
  role: Role;
}

/** The stable part of an authorization request: the same value on `/authorize` and its consent page. */
export function oauthRequestKey(query: string | undefined): string | undefined {
  if (!query) return undefined;
  const params = new URLSearchParams(query);
  const stable = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'response_type']
    .map((key) => `${key}=${params.get(key) ?? ''}`)
    .join('\n');
  // A request without any of them has no identity to bind to; the session fallback would race.
  return params.get('client_id') || params.get('state') ? sha256(stable) : undefined;
}

type ConsentRequest = {
  query: string | undefined;
  /** `authorize` looks up an existing consent; `consent` records the person's decision. */
  mode: 'authorize' | 'consent';
  /**
   * The workspace resolved for this request. The provider calls the hook once while recording the
   * consent and once more when it continues to `/authorize` to issue the code; both calls in one
   * request must see the same brand, and the stored choice is consumed by the first.
   */
  resolved?: boolean;
  selection?: string;
};

const requestState = new AsyncLocalStorage<ConsentRequest>();

/** Runs `fn` so `consentReferenceId` can see which authorization request it is serving (#456). */
export function withConsentRequest<T>(request: ConsentRequest, fn: () => T): T {
  return requestState.run(request, fn);
}

/** The permission scopes in an OAuth scope string (identity scopes such as `openid` are ignored). */
export function permissionScopes(scope: string | undefined): Permission[] {
  return (scope ?? '').split(' ').filter((s): s is Permission => (PERMISSIONS as readonly string[]).includes(s));
}

/**
 * A reference id that matches no grant. In the `authorize` step a person with several brands and
 * no choice for this exact request must be sent back to the consent page rather than reuse a
 * grant for another brand; without a reference id the provider would match any of their grants.
 */
const unboundReference = (key: string) => `unbound-request-${key.slice(0, 32)}`;

/** Records the workspace the person chose on the consent page, after checking they may grant it. */
export async function chooseOAuthWorkspace(
  db: Db,
  input: { sessionId: string; userId: string; workspaceId: string; scope?: string; oauthQuery?: string },
): Promise<OAuthWorkspaceChoice> {
  const { rows } = await db.admin.query<{ id: string; name: string; role: Role }>(
    `SELECT w.id, w.name, m.role
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND m.workspace_id = $2`,
    [input.userId, input.workspaceId],
  );
  const m = rows[0];
  if (!m) throw new AppError('forbidden', 'You are not a member of that workspace. Choose a brand you belong to.');
  const extra = permissionScopes(input.scope).filter((p) => !ROLE_PERMISSIONS[m.role].includes(p));
  if (extra.length)
    throw new AppError(
      'forbidden',
      `Your role (${m.role}) in ${m.name} cannot grant ${extra.join(', ')}. Ask an owner or admin there to change your role, or choose another brand.`,
    );
  const key = oauthRequestKey(input.oauthQuery);
  if (!key)
    throw new AppError(
      'invalid_input',
      'Reload the consent page and choose the brand again: this choice has no authorization request to bind to.',
    );
  // A choice is only valid for its own request, so the row is keyed by the session and that
  // request; the table predates per-request choices, so 0.10.1 reuses the session_id column
  // rather than migrating the schema (the value is opaque to every reader below).
  //
  // The workspace is known, so the write runs as the app role under RLS, never the owner pool. The
  // key includes the workspace: re-picking another brand for the same request adds a row instead
  // of needing to see and rewrite a row from a workspace this transaction cannot touch.
  // `consentWorkspaceId` consumes the latest row and drops the rest; the scheduler removes
  // abandoned rows.
  const sessionKey = selectionId(input.sessionId, key);
  await db.withWorkspace(input.workspaceId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO oauth_workspace_selections (session_id, workspace_id) VALUES (${sessionKey}, ${input.workspaceId})
      ON CONFLICT (session_id, workspace_id) DO UPDATE SET updated_at = now()`);
  });
  return m;
}

/** How long an abandoned consent choice stays; the flow itself takes minutes. */
export const OAUTH_SELECTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Drops pending consent choices nobody came back for. Deliberately cross-tenant and deliberately
 * outside a request: the scheduler runs it as the owner, while every request writes only the
 * workspace it just chose under RLS.
 */
export async function cleanupExpiredOAuthWorkspaceSelections(db: Db, now: Date = new Date()): Promise<number> {
  const { rowCount } = await db.admin.query('DELETE FROM oauth_workspace_selections WHERE updated_at < $1', [
    new Date(now.getTime() - OAUTH_SELECTION_TTL_MS),
  ]);
  return rowCount ?? 0;
}

/** The row key: the session alone was the old, racy key; the request hash scopes it per tab. */
const selectionId = (sessionId: string, requestKey: string) => `${sessionId}:${requestKey}`;

/**
 * The workspace to bind a consent to: the choice made for this exact authorization request, else
 * the only membership a person has. A person with several memberships and no choice for this
 * request gets `undefined`; the consent page asks, and the issued token without the claim is
 * refused rather than silently acting in one brand.
 */
export async function consentWorkspaceId(db: Db, userId: string, sessionId: string): Promise<string | undefined> {
  const request = requestState.getStore();
  if (request?.resolved) return request.selection;
  const key = oauthRequestKey(request?.query);
  const resolve = (selection: string | undefined) => {
    if (request) {
      request.resolved = true;
      request.selection = selection;
    }
    return selection;
  };
  const memberships = await db.admin.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  const membership = (workspaceId: string) => memberships.rows.some((m) => m.workspace_id === workspaceId);

  if (key) {
    // Read the latest choice and consume every row for this request in one statement: the most
    // recent brand the person picked wins, and a replay cannot reuse an earlier pick.
    const { rows } = await db.admin.query<{ workspace_id: string }>(
      `WITH picked AS (
         SELECT workspace_id, updated_at FROM oauth_workspace_selections
          WHERE session_id = $1 ORDER BY updated_at DESC LIMIT 1
       ), removed AS (
         DELETE FROM oauth_workspace_selections WHERE session_id = $1
       )
       SELECT workspace_id FROM picked`,
      [selectionId(sessionId, key)],
    );
    const chosen = rows[0]?.workspace_id;
    if (chosen && membership(chosen)) return resolve(chosen);
  }
  if (memberships.rows.length === 1) return resolve(memberships.rows[0].workspace_id);
  // Several brands and no choice for this request: never reuse another request's grant.
  if (request?.mode === 'authorize' && key) return resolve(unboundReference(key));
  return resolve(undefined);
}

/** A grant's reference id is a workspace; anything else (an unbound sentinel) carries no claim. */
export const isWorkspaceReference = (referenceId: string | undefined): referenceId is string =>
  typeof referenceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(referenceId);

/** The workspace a credential is bound to, with the role the person has there, or undefined. */
export async function boundMembership(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<{ workspace_id: string; role: Role } | undefined> {
  const { rows } = await db.admin.query<{ workspace_id: string; role: Role }>(
    'SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2',
    [userId, workspaceId],
  );
  return rows[0];
}
