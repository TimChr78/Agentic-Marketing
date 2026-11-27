import {
  type Auth,
  scimDeleteGroup,
  scimDeleteUser,
  scimPrincipal,
  scimUpsertGroup,
  scimUpsertUser,
  workspaceForScimToken,
} from '@agentic-marketing/auth';
import type { Executor } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import type { Db } from '@agentic-marketing/db';
import { bodyLimit } from '@agentic-marketing/ingest';
import { Hono } from 'hono';

// SCIM 2.0 (RFC 7643, 7644) for identity providers: Users and Groups of one workspace, chosen by
// the bearer token. People are accounts in the auth tables (created here when new, signing in
// with SSO); what SCIM changes about the workspace goes through internal commands, so it is
// audited like any other change. Supported: list with `eq` filters on userName, externalId and
// displayName, get, create, replace, PATCH (add, replace, remove, as Okta and Entra ID send them)
// and delete.

const CORE_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const CORE_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const TYPE = 'application/scim+json';

// Sized for the biggest resource the command schemas accept, not for a typical one: `scimUpsertGroup`
// takes 50,000 members, and an identity provider that also sends each member's display name (Okta
// and Entra ID do) needs about 6 MB for that group alone (#1236). The limit runs before the bearer
// token lookup and before the JSON is parsed.
export const SCIM_MAX_BODY = 8 * 1024 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: SCIM bodies are free-form JSON from the identity provider, read field by field
type Json = Record<string, any>;

class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

/** Parses `attr eq "value"` (the filters identity providers use). */
function eqFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = filter.match(/^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i);
  if (!m) throw new ScimError(400, 'Only filters of the form attribute eq "value" are supported.', 'invalidFilter');
  return { attr: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, '$1') };
}

/**
 * PostgreSQL 23505 on the `user.email` unique index, directly or wrapped by the auth adapter. Two
 * concurrent replaces can both pass the "is this address free?" lookup; the index then decides at
 * the write (#1272 review).
 */
function emailUniqueViolation(err: unknown): boolean {
  for (
    let e = err as { code?: unknown; constraint?: unknown; detail?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 5;
    e = e.cause as typeof e, depth++
  ) {
    if (e.code !== '23505') continue;
    if (String(e.constraint ?? '').includes('email') || String(e.detail ?? '').includes('(email)')) return true;
  }
  return false;
}

export function scimApi(deps: { auth: Auth; db: Db; executor: Executor; publicUrl: string }) {
  const app = new Hono<{ Variables: { ws: string } }>();
  const base = `${deps.publicUrl}/scim/v2`;
  const reply = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': TYPE } });

  app.use(
    '/scim/v2/*',
    bodyLimit(SCIM_MAX_BODY, () =>
      reply({ schemas: [ERROR], status: '413', detail: `SCIM requests are limited to ${SCIM_MAX_BODY / (1024 * 1024)} MB.` }, 413),
    ),
  );
  app.use('/scim/v2/*', async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    const ws = token ? await workspaceForScimToken(deps.db, token) : null;
    if (!ws) return reply({ schemas: [ERROR], status: '401', detail: 'A valid SCIM bearer token is required.' }, 401);
    c.set('ws', ws);
    await next();
  });
  app.onError((err) => {
    const expected = err instanceof ScimError || err instanceof AppError;
    const status = err instanceof ScimError ? err.status : err instanceof AppError ? err.status : 500;
    const scimType = err instanceof ScimError ? err.scimType : undefined;
    // A SCIM client is another role, so an unexpected exception keeps the fixed server message
    // rather than its text (SQL, secrets or driver details); expected errors stay specific.
    const detail = expected ? err.message : 'Something went wrong on our side.';
    return reply({ schemas: [ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail }, status);
  });

  const run = <C extends Parameters<Executor['execute']>[0]>(cmd: C, input: unknown, ws: string) =>
    deps.executor.execute(cmd, input, scimPrincipal(ws), { surface: 'scim' });

  // ---------- Users ----------

  interface UserRow {
    id: string;
    email: string;
    name: string;
    created_at: Date;
    updated_at: Date;
    external_id: string | null;
    active: boolean;
  }
  /** People of the workspace: its members and anyone SCIM manages (active or not). */
  async function users(ws: string, where = '', params: unknown[] = []) {
    const { rows } = await deps.db.admin.query<UserRow>(
      `SELECT u.id, u.email, u.name, u."createdAt" AS created_at, u."updatedAt" AS updated_at, s.external_id,
              coalesce(s.active, true) AND m.user_id IS NOT NULL AS active
       FROM "user" u
       LEFT JOIN scim_users s ON s.workspace_id = $1 AND s.user_id = u.id
       LEFT JOIN workspace_members m ON m.workspace_id = $1 AND m.user_id = u.id
       WHERE (s.user_id IS NOT NULL OR m.user_id IS NOT NULL) ${where}
       ORDER BY u."createdAt", u.id`,
      [ws, ...params],
    );
    return rows;
  }
  async function groupsOf(ws: string, userId: string) {
    const { rows } = await deps.db.admin.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM scim_groups WHERE workspace_id = $1 AND $2 = ANY(members)',
      [ws, userId],
    );
    return rows.map((g) => ({ value: g.id, display: g.display_name, $ref: `${base}/Groups/${g.id}` }));
  }
  const userResource = async (ws: string, u: UserRow) => {
    const [given, ...family] = u.name.split(' ');
    return {
      schemas: [CORE_USER],
      id: u.id,
      ...(u.external_id ? { externalId: u.external_id } : {}),
      userName: u.email,
      displayName: u.name,
      name: { formatted: u.name, givenName: given ?? '', familyName: family.join(' ') },
      emails: [{ value: u.email, primary: true, type: 'work' }],
      active: u.active,
      groups: await groupsOf(ws, u.id),
      meta: { resourceType: 'User', created: u.created_at, lastModified: u.updated_at, location: `${base}/Users/${u.id}` },
    };
  };
  async function userById(ws: string, id: string) {
    const [u] = await users(ws, 'AND u.id = $2', [id]);
    if (!u) throw new ScimError(404, `User ${id} not found.`);
    return u;
  }
  const nameOf = (body: Json, fallback: string) =>
    body.displayName ?? body.name?.formatted ?? ([body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ') || fallback);
  const emailOf = (body: Json) =>
    String(body.userName ?? body.emails?.find((e: Json) => e.primary)?.value ?? body.emails?.[0]?.value ?? '').toLowerCase();

  /** Whether the person owns this workspace; SCIM never hands owners to an identity provider. */
  async function isOwner(ws: string, userId: string) {
    const { rows } = await deps.db.admin.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [ws, userId],
    );
    return rows[0]?.role === 'owner';
  }

  /**
   * Whether an account is also used outside this workspace, or owns any workspace. A workspace's
   * SCIM integration may only rename such an account inside its own workspace: the global
   * `user.email` is the sign-in identity of every workspace at once (#1129).
   */
  async function sharedOutside(ws: string, userId: string) {
    const { rows } = await deps.db.admin.query<{ shared: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id <> $2)
           OR EXISTS (SELECT 1 FROM scim_users WHERE user_id = $1 AND workspace_id <> $2)
           OR EXISTS (SELECT 1 FROM workspace_members WHERE user_id = $1 AND role = 'owner') AS shared`,
      [userId, ws],
    );
    return rows[0]?.shared === true;
  }

  /** A verified single sign-on domain of this workspace is the only claim that may link an existing account. */
  async function verifiedSsoDomain(ws: string, email: string) {
    const domain = email.split('@')[1];
    if (!domain) return false;
    const { rowCount } = await deps.db.admin.query(
      'SELECT 1 FROM "ssoProvider" WHERE "workspaceId" = $1 AND lower(domain) = $2 AND "domainVerified" LIMIT 1',
      [ws, domain],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * The 409 for an address another account already holds. Create answers it before writing, and a
   * replace answers the same way — through this helper both when its lookup sees the account and
   * when two concurrent replaces reach the unique index (#1129, #1233, #1272 review).
   */
  async function addressConflict(ws: string, email: string, ownerId: string | undefined) {
    const known = ownerId ? (await users(ws, 'AND u.id = $2', [ownerId]))[0] : undefined;
    return known
      ? new ScimError(409, `${email} is already provisioned.`, 'uniqueness')
      : new ScimError(
          409,
          'This user name cannot be provisioned automatically. The person must sign in through a verified single sign-on domain of this workspace, or be invited.',
          'uniqueness',
        );
  }

  /** Applies SCIM user attributes: the account (name, e-mail) and the workspace side (active, external id). */
  async function saveUser(ws: string, id: string | null, body: Json) {
    const ctx = await deps.auth.$context;
    const email = emailOf(body);
    if (!email.includes('@')) throw new ScimError(400, 'userName must be an e-mail address.', 'invalidValue');
    const name = nameOf(body, email);
    let userId = id;
    if (!userId) {
      const existing = await ctx.internalAdapter.findUserByEmail(email);
      if (existing) {
        const known = (await users(ws, 'AND u.id = $2', [existing.user.id]))[0];
        if (known && (known.active || known.external_id)) throw new ScimError(409, `${email} is already provisioned.`, 'uniqueness');
        // Linking an account this workspace does not already manage needs a verified SSO claim on
        // its domain. The message says nothing about the other workspace such an account may
        // belong to; the 409 `uniqueness` is all the caller learns (#1129).
        if (!known && !(await verifiedSsoDomain(ws, email)))
          throw new ScimError(
            409,
            'This user name cannot be provisioned automatically. The person must sign in through a verified single sign-on domain of this workspace, or be invited.',
            'uniqueness',
          );
        userId = existing.user.id;
      } else {
        userId = (await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: 'scim' })).id;
      }
    } else {
      if (await isOwner(ws, userId)) throw new ScimError(403, 'Owners are managed by people, not by SCIM.');
      const [current] = await users(ws, 'AND u.id = $2', [userId]);
      if (!current) throw new ScimError(404, `User ${userId} not found.`);
      // A shared account keeps its global e-mail and name, but the workspace side (active,
      // externalId) still applies. Compare against the stored account, not the request, so a PUT
      // that repeats the current values is not blocked.
      if (
        (email !== current.email.toLowerCase() || name.toLowerCase() !== (current.name ?? '').toLowerCase()) &&
        (await sharedOutside(ws, userId))
      ) {
        await run(scimUpsertUser, { userId, externalId: body.externalId ?? null, active: body.active ?? true }, ws);
        throw new ScimError(
          409,
          'This account’s e-mail address and name cannot be changed through SCIM here. Change only active and externalId.',
          'mutability',
        );
      }
      // A replace must not take an address another account already holds: the unique index on
      // `user.email` would answer with a driver error, which the handler reports as a 500 and an
      // identity provider then retries forever (#1233). Create looks the address up first, so
      // replace does too, and answers 409 `uniqueness` in the same words.
      if (email !== current.email.toLowerCase()) {
        const taken = await ctx.internalAdapter.findUserByEmail(email);
        if (taken && taken.user.id !== userId) {
          await run(scimUpsertUser, { userId, externalId: body.externalId ?? null, active: body.active ?? true }, ws);
          throw await addressConflict(ws, email, taken.user.id);
        }
      }
      try {
        await ctx.internalAdapter.updateUser(userId, { name, email });
      } catch (err) {
        // Two concurrent replaces can both find the address free; the write then meets the unique
        // index. The loser answers what its lookup would have answered, never a 500 (#1272 review).
        if (!emailUniqueViolation(err)) throw err;
        await run(scimUpsertUser, { userId, externalId: body.externalId ?? null, active: body.active ?? true }, ws);
        throw await addressConflict(ws, email, (await ctx.internalAdapter.findUserByEmail(email))?.user.id);
      }
    }
    await run(scimUpsertUser, { userId, externalId: body.externalId ?? null, active: body.active ?? true }, ws);
    return userResource(ws, await userById(ws, userId));
  }

  app.get('/scim/v2/Users', async (c) => {
    const ws = c.get('ws');
    const f = eqFilter(c.req.query('filter'));
    const columns: Record<string, string> = { username: 'lower(u.email)', externalid: 's.external_id', 'emails.value': 'lower(u.email)' };
    if (f && !columns[f.attr]) throw new ScimError(400, `Filtering on ${f.attr} is not supported.`, 'invalidFilter');
    const all = f
      ? await users(ws, `AND ${columns[f.attr]} = $2`, [f.attr === 'externalid' ? f.value : f.value.toLowerCase()])
      : await users(ws);
    const start = Math.max(1, Number(c.req.query('startIndex') ?? 1));
    const count = Math.min(200, Math.max(0, Number(c.req.query('count') ?? 100)));
    const page = all.slice(start - 1, start - 1 + count);
    return reply({
      schemas: [LIST],
      totalResults: all.length,
      startIndex: start,
      itemsPerPage: page.length,
      Resources: await Promise.all(page.map((u) => userResource(ws, u))),
    });
  });
  app.get('/scim/v2/Users/:id', async (c) => reply(await userResource(c.get('ws'), await userById(c.get('ws'), c.req.param('id')))));
  app.post('/scim/v2/Users', async (c) => reply(await saveUser(c.get('ws'), null, await c.req.json()), 201));
  app.put('/scim/v2/Users/:id', async (c) => {
    await userById(c.get('ws'), c.req.param('id'));
    return reply(await saveUser(c.get('ws'), c.req.param('id'), await c.req.json()));
  });
  app.patch('/scim/v2/Users/:id', async (c) => {
    const ws = c.get('ws');
    const u = await userById(ws, c.req.param('id'));
    const current = await userResource(ws, u);
    const body: Json = { userName: current.userName, displayName: current.displayName, externalId: u.external_id, active: u.active };
    for (const op of (await c.req.json()).Operations ?? []) {
      const kind = String(op.op).toLowerCase();
      if (kind === 'remove') continue;
      const changes: Json = op.path ? { [op.path]: op.value } : (op.value ?? {});
      for (const [path, value] of Object.entries(changes)) {
        const p = path.toLowerCase();
        if (p === 'active') body.active = value === true || value === 'True' || value === 'true';
        else if (p === 'username') body.userName = value;
        else if (p === 'displayname' || p === 'name.formatted') body.displayName = value;
        else if (p === 'externalid') body.externalId = value;
        else if (p.startsWith('emails')) body.userName = Array.isArray(value) ? value[0]?.value : value;
        else if (p === 'name' && value && typeof value === 'object') body.displayName = nameOf({ name: value }, body.displayName);
      }
    }
    return reply(await saveUser(ws, u.id, body));
  });
  app.delete('/scim/v2/Users/:id', async (c) => {
    await userById(c.get('ws'), c.req.param('id'));
    await run(scimDeleteUser, { userId: c.req.param('id') }, c.get('ws'));
    return reply(null, 204);
  });

  // ---------- Groups ----------

  interface GroupRow {
    id: string;
    display_name: string;
    external_id: string | null;
    members: string[];
    created_at: Date;
    updated_at: Date;
  }
  async function groups(ws: string, where = '', params: unknown[] = []) {
    return (
      await deps.db.admin.query<GroupRow>(`SELECT * FROM scim_groups WHERE workspace_id = $1 ${where} ORDER BY created_at, id`, [
        ws,
        ...params,
      ])
    ).rows;
  }
  async function groupById(ws: string, id: string) {
    const [g] = await groups(ws, 'AND id = $2', [id]);
    if (!g) throw new ScimError(404, `Group ${id} not found.`);
    return g;
  }
  const groupResource = (g: GroupRow) => ({
    schemas: [CORE_GROUP],
    id: g.id,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    displayName: g.display_name,
    members: g.members.map((m) => ({ value: m, $ref: `${base}/Users/${m}` })),
    meta: { resourceType: 'Group', created: g.created_at, lastModified: g.updated_at, location: `${base}/Groups/${g.id}` },
  });
  const memberIds = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((m: Json) => String(m.value ?? m));
  const saveGroup = async (ws: string, id: string, displayName: string, externalId: string | null, members: string[]) => {
    await run(scimUpsertGroup, { id, displayName, externalId, members }, ws);
    return groupResource(await groupById(ws, id));
  };

  app.get('/scim/v2/Groups', async (c) => {
    const ws = c.get('ws');
    const f = eqFilter(c.req.query('filter'));
    const columns: Record<string, string> = { displayname: 'display_name', externalid: 'external_id' };
    if (f && !columns[f.attr]) throw new ScimError(400, `Filtering on ${f.attr} is not supported.`, 'invalidFilter');
    const all = f ? await groups(ws, `AND ${columns[f.attr]} = $2`, [f.value]) : await groups(ws);
    // Okta and Entra ID ask for groups without members when they only need ids.
    const slim = c.req.query('excludedAttributes')?.includes('members');
    return reply({
      schemas: [LIST],
      totalResults: all.length,
      startIndex: 1,
      itemsPerPage: all.length,
      Resources: all.map((g) => (slim ? { ...groupResource(g), members: undefined } : groupResource(g))),
    });
  });
  app.get('/scim/v2/Groups/:id', async (c) => reply(groupResource(await groupById(c.get('ws'), c.req.param('id')))));
  app.post('/scim/v2/Groups', async (c) => {
    const body = await c.req.json();
    if (!body.displayName) throw new ScimError(400, 'displayName is required.', 'invalidValue');
    return reply(await saveGroup(c.get('ws'), newId('grp'), body.displayName, body.externalId ?? null, memberIds(body.members)), 201);
  });
  app.put('/scim/v2/Groups/:id', async (c) => {
    const ws = c.get('ws');
    const g = await groupById(ws, c.req.param('id'));
    const body = await c.req.json();
    return reply(await saveGroup(ws, g.id, body.displayName ?? g.display_name, body.externalId ?? g.external_id, memberIds(body.members)));
  });
  app.patch('/scim/v2/Groups/:id', async (c) => {
    const ws = c.get('ws');
    const g = await groupById(ws, c.req.param('id'));
    let { display_name: name, external_id: externalId } = g;
    const members = new Set(g.members);
    const body = await c.req.json();
    if (!body.schemas?.includes(PATCH) && !body.Operations) throw new ScimError(400, 'Expected a PatchOp.', 'invalidSyntax');
    for (const op of body.Operations ?? []) {
      const kind = String(op.op).toLowerCase();
      const path = String(op.path ?? '').toLowerCase();
      // remove with a filter: members[value eq "id"]
      const filtered = String(op.path ?? '').match(/^members\[value eq "([^"]+)"\]$/i)?.[1];
      if (kind === 'remove' && filtered) members.delete(filtered);
      else if (kind === 'remove' && path === 'members') {
        if (op.value === undefined) members.clear();
        else for (const m of memberIds(op.value)) members.delete(m);
      } else if (kind === 'add' && path === 'members') for (const m of memberIds(op.value)) members.add(m);
      else if (kind === 'replace' && path === 'members') {
        members.clear();
        for (const m of memberIds(op.value)) members.add(m);
      } else if (kind === 'replace' || kind === 'add') {
        const changes: Json = op.path ? { [op.path]: op.value } : (op.value ?? {});
        for (const [k, v] of Object.entries(changes)) {
          if (k.toLowerCase() === 'displayname') name = String(v);
          else if (k.toLowerCase() === 'externalid') externalId = String(v);
          else if (k.toLowerCase() === 'members') for (const m of memberIds(v)) members.add(m);
        }
      }
    }
    return reply(await saveGroup(ws, g.id, name, externalId, [...members]));
  });
  app.delete('/scim/v2/Groups/:id', async (c) => {
    await groupById(c.get('ws'), c.req.param('id'));
    await run(scimDeleteGroup, { id: c.req.param('id') }, c.get('ws'));
    return reply(null, 204);
  });

  // ---------- Discovery ----------

  app.get('/scim/v2/ServiceProviderConfig', () =>
    reply({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { type: 'oauthbearertoken', name: 'Bearer token', description: 'The workspace SCIM token (scim.rotateToken).' },
      ],
    }),
  );
  app.get('/scim/v2/ResourceTypes', () =>
    reply({
      schemas: [LIST],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: CORE_USER,
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: CORE_GROUP,
        },
      ],
    }),
  );

  // Unmatched /scim paths answer with a SCIM error document, never the admin SPA (#610). These are
  // registered last so every real route above keeps precedence.
  const notFound = () => reply({ schemas: [ERROR], status: '404', detail: 'Not found.' }, 404);
  app.all('/scim', notFound);
  app.all('/scim/*', notFound);

  return app;
}
