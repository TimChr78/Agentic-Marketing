import {
  agentForCredential,
  chooseOAuthWorkspace,
  cleanupExpiredOAuthWorkspaceSelections,
  consentWorkspaceId,
  withConsentRequest,
} from '@agentic-marketing/auth';
import { newUuid } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAUTH_SELECTION_CLEANUP_TASK, runOAuthSelectionCleanup } from '../src/workers';
import { eventually, startTestServer, testPort, type User } from './harness';

// Tenant writes on the credential path must run as `am_app` under RLS. The owner pool is for the
// installation-level lookups that happen before a workspace is known (the token hash, the session
// membership) and never for rows that carry a workspace. The expired-choice cleanup is the one
// deliberate cross-tenant operation, and it runs from the scheduler, not a request.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

beforeAll(async () => {
  t = await startTestServer('tenant_writes', testPort(2507));
  owner = await t.signUp(`tenant-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
});

afterAll(async () => {
  await t?.close();
});

/**
 * A Db whose owner pool refuses tenant writes. Anything that inserts, updates or deletes through
 * `admin`, or opens an owner connection to do so, is recorded and thrown; the app pool and
 * `withWorkspace` stay real.
 */
function refusingOwnerWrites(db: Db): { db: Db; attempted: string[] } {
  const attempted: string[] = [];
  const refuse = (what: string): never => {
    attempted.push(what);
    throw new Error(`owner pool used for ${what}`);
  };
  const admin = new Proxy(db.admin, {
    get(target, prop, receiver) {
      if (prop === 'connect') return () => refuse('a connection');
      if (prop === 'query') {
        return (text: string, values?: unknown[]) => {
          // A write may hide inside a CTE (`WITH picked AS (…) DELETE …`), as the old consent
          // consumer's did, so look past the leading keyword as well.
          const sql = String(text);
          if (/^\s*(insert|update|delete)\b/i.test(sql) || /^\s*with\b[\s\S]*\b(insert|update|delete)\b/i.test(sql))
            return refuse('a tenant write');
          return target.query(text as never, values as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: { ...db, admin }, attempted };
}

describe('tenant writes on the auth path (#838)', () => {
  it('creates an agent for a first-used credential as the app role under RLS', async () => {
    const { db, attempted } = refusingOwnerWrites(t.srv.db);
    const agent = await agentForCredential(db, ws, 'api_token', 'tok_tenant_probe', owner.id, async () => 'Probe agent');
    expect(agent).toMatchObject({ name: 'Probe agent', status: 'active' });
    expect(attempted).toEqual([]);

    const { rows } = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM agents WHERE id = ${agent.id}`),
    );
    expect(rows).toEqual([{ id: agent.id }]);
    // RLS: another workspace's transaction cannot see the row.
    const elsewhere = await t.srv.db.withWorkspace(newUuid(), (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM agents WHERE id = ${agent.id}`),
    );
    expect(elsewhere.rows).toEqual([]);
  });

  it('records a consent workspace choice as the app role under RLS', async () => {
    const { db, attempted } = refusingOwnerWrites(t.srv.db);
    const chosen = await chooseOAuthWorkspace(db, {
      sessionId: 'session-tenant-probe',
      userId: owner.id,
      workspaceId: ws,
      oauthQuery: 'client_id=probe-client&state=probe-state&response_type=code',
    });
    expect(chosen).toMatchObject({ id: ws });
    expect(attempted).toEqual([]);

    const { rows } = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id::text FROM oauth_workspace_selections WHERE workspace_id = ${ws}`),
    );
    expect(rows.length).toBeGreaterThan(0);
    const elsewhere = await t.srv.db.withWorkspace(newUuid(), (tx) =>
      tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id::text FROM oauth_workspace_selections`),
    );
    expect(elsewhere.rows).toEqual([]);
  });

  it('replaces a choice when the person picks another brand in the same request (#838)', async () => {
    const wsB = await t.workspaceWith([[owner, 'owner']]);
    const { db, attempted } = refusingOwnerWrites(t.srv.db);
    const oauthQuery = 'client_id=repick-client&state=repick-state&response_type=code';

    // A, then B in the same consent request. B's transaction cannot see A's row under tenant
    // isolation, which is why the table also admits the session key it names.
    await chooseOAuthWorkspace(db, { sessionId: 'session-repick', userId: owner.id, workspaceId: ws, oauthQuery });
    await chooseOAuthWorkspace(db, { sessionId: 'session-repick', userId: owner.id, workspaceId: wsB, oauthQuery });
    expect(attempted).toEqual([]);

    // The replaced row moved to B: A cannot see it, B can.
    const fromA = await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id::text FROM oauth_workspace_selections WHERE workspace_id = ${wsB}`),
    );
    expect(fromA.rows).toEqual([]);
    const fromB = await t.srv.db.withWorkspace(wsB, (tx) =>
      tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id::text FROM oauth_workspace_selections WHERE workspace_id = ${wsB}`),
    );
    expect(fromB.rows).toEqual([{ workspace_id: wsB }]);

    // Consuming runs as the app role too; the choice is the latest pick and is used once.
    const resolve = () =>
      withConsentRequest({ query: oauthQuery, mode: 'consent' }, () => consentWorkspaceId(db, owner.id, 'session-repick'));
    expect(await resolve()).toBe(wsB);
    expect(await resolve()).toBeUndefined();
    expect(attempted).toEqual([]);
  });

  it('leaves abandoned choices to the scheduler and cleans up every workspace', async () => {
    const otherWorkspace = newUuid();
    await t.srv.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [otherWorkspace, 'Other', 'none']);
    await t.srv.db.admin.query(
      `INSERT INTO oauth_workspace_selections (session_id, workspace_id, created_at, updated_at) VALUES
         ('abandoned-request', $1, now() - interval '2 days', now() - interval '2 days'),
         ('expired-other', $2, now() - interval '2 days', now() - interval '2 days'),
         ('fresh-c', $1, now(), now())`,
      [ws, otherWorkspace],
    );

    // The request path only writes its own choice; it does not sweep other tenants.
    await chooseOAuthWorkspace(t.srv.db, {
      sessionId: 'session-cleanup-probe',
      userId: owner.id,
      workspaceId: ws,
      oauthQuery: 'client_id=cleanup-client&state=cleanup-state&response_type=code',
    });
    const stillThere = await t.srv.db.admin.query<{ session_id: string }>(
      "SELECT session_id FROM oauth_workspace_selections WHERE session_id = 'abandoned-request'",
    );
    expect(stillThere.rows).toHaveLength(1);

    expect(await cleanupExpiredOAuthWorkspaceSelections(t.srv.db)).toBe(2);
    const { rows } = await t.srv.db.admin.query<{ session_id: string }>(
      'SELECT session_id FROM oauth_workspace_selections ORDER BY session_id',
    );
    const remaining = rows.map((row) => row.session_id);
    expect(remaining).not.toContain('abandoned-request');
    expect(remaining).not.toContain('expired-other');
    expect(remaining).toContain('fresh-c');
  });

  it('registers the cleanup as a scheduler job', async () => {
    expect(OAUTH_SELECTION_CLEANUP_TASK).toBe('oauth-workspace-selections.cleanup');
    await t.srv.db.admin.query(
      `INSERT INTO oauth_workspace_selections (session_id, workspace_id, created_at, updated_at)
       VALUES ('loop-expired', $1, now() - interval '2 days', now() - interval '2 days')`,
      [ws],
    );
    const stop = new AbortController();
    const done = runOAuthSelectionCleanup(t.srv.db, stop.signal, { tickMs: 50 });
    try {
      await eventually(
        async () =>
          (
            await t.srv.db.admin.query<{ session_id: string }>(
              "SELECT session_id FROM oauth_workspace_selections WHERE session_id = 'loop-expired'",
            )
          ).rows.length,
        (n) => n === 0,
        5_000,
      );
    } finally {
      stop.abort();
      await done;
    }
  });
});
