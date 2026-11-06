import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Db, DomainError, normalizeDomainInput, normalizeHost, originForHost, schema } from '@agentic-marketing/db';
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

// Brand domains (#186): the hostnames a workspace's public links answer on. A brand is a
// workspace, so one row per hostname (and optional path prefix) is enough; the resolver reads the
// table across workspaces, while these commands edit only the caller's rows under RLS.

type DomainRow = typeof schema.workspaceDomains.$inferSelect;

declare module '@agentic-marketing/commands' {
  interface Services {
    /**
     * Normalised hostnames reserved installation-wide: the admin host (PUBLIC_URL) and the fallback
     * links host (PUBLIC_LINKS_URL). Wired by the server (#480).
     */
    reservedDomainHosts?: string[];
    /** Persist that brand Host checking is on (#463); wired by the server's domain service. */
    activateDomainRouting?: () => Promise<void>;
    /** The pool itself, for installation-wide host claims that RLS would hide (#462, #467). */
    db?: Db;
  }
}

const DomainStatus = z.enum(['pending', 'verified']);

export const DomainViewSchema = z.object({
  id: z.string(),
  host: z.string(),
  pathPrefix: z.string().nullable().describe('Path prefix the domain serves, or null for the whole host'),
  isPrimary: z.boolean().describe('The primary domain supplies the workspace links URL'),
  status: DomainStatus.describe('Only verified domains resolve requests and supply links'),
  verificationToken: z
    .string()
    .nullable()
    .describe('Token the public listener serves at /.well-known/am-domain/<token>; workspace.domains.verify checks it'),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
  url: z.string().describe('Origin and prefix this domain serves, for example https://example.com/am'),
});

export type DomainView = z.output<typeof DomainViewSchema>;

export function domainView(row: DomainRow): DomainView {
  return {
    id: row.id,
    host: row.host,
    pathPrefix: row.pathPrefix,
    isPrimary: row.isPrimary,
    status: row.status,
    verificationToken: row.verificationToken,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    url: `${originForHost(row.host)}${row.pathPrefix ?? ''}`,
  };
}

function invalidInput(err: unknown): never {
  if (err instanceof DomainError) throw new AppError('invalid_input', err.message);
  throw err;
}

/** The workspace's primary domain origin+prefix, else the installation's PUBLIC_LINKS_URL. */
export async function effectiveLinksUrl(ctx: CommandContext, domains?: DomainRow[]): Promise<string> {
  if (ctx.services.linksUrlFor) return ctx.services.linksUrlFor(ctx.principal.workspaceId);
  const rows = domains ?? (await ctx.tx.select().from(schema.workspaceDomains));
  const primary = rows.find((row) => row.isPrimary && row.status === 'verified');
  return primary ? `${originForHost(primary.host)}${primary.pathPrefix ?? ''}` : (ctx.services.linksUrl ?? ctx.services.publicUrl ?? '');
}

function domainIdList(rows: DomainRow[]) {
  return rows.map(domainView);
}

/** Ask the running resolver to drop its cache once the write commits. */
function invalidateResolver(ctx: CommandContext) {
  const invalidate = () => ctx.services.invalidateDomainCache?.();
  if (ctx.afterCommit) ctx.afterCommit(async () => invalidate());
  else invalidate();
}

/**
 * A successful verification switches Host checking on for the installation and keeps it on (#463).
 * The resolver persists the fact and drops its cache once the transaction commits.
 */
function activateDomainRouting(ctx: CommandContext) {
  const activate = async () => {
    if (ctx.services.activateDomainRouting) await ctx.services.activateDomainRouting();
    else ctx.services.invalidateDomainCache?.();
  };
  if (ctx.afterCommit) ctx.afterCommit(activate);
  else void activate();
}

/** Drizzle wraps driver errors; the Postgres code and constraint sit on the cause chain. */
function postgresError(err: unknown): { code?: string; constraint?: string } {
  let current = err as { code?: string; constraint?: string; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code || current.constraint) return current;
    current = current.cause as typeof current;
  }
  return {};
}

/** Turns the two unique indexes into messages that say what to change. */
export function mapUniqueViolation(err: unknown): never {
  const { code, constraint } = postgresError(err);
  if (code === '23505') {
    if (constraint === 'workspace_domains_primary')
      throw new AppError(
        'invalid_input',
        'This workspace already has a primary domain. Clear the current one with workspace.domains.update before making another primary.',
      );
    throw new AppError(
      'invalid_input',
      'That hostname and path prefix is already registered, possibly by another workspace. Choose a different host or prefix.',
    );
  }
  throw err;
}

async function assertNoOtherPrimary(ctx: CommandContext, excludedId?: string) {
  const rows = await ctx.tx.select().from(schema.workspaceDomains).where(eq(schema.workspaceDomains.isPrimary, true));
  if (rows.some((row) => row.id !== excludedId))
    throw new AppError(
      'invalid_input',
      'This workspace already has a primary domain. Clear the current one with workspace.domains.update before making another primary.',
    );
}

const normalized = (input: { host: string; pathPrefix?: string | null }) => {
  try {
    return normalizeDomainInput(input);
  } catch (err) {
    return invalidInput(err);
  }
};

/** The admin host and fallback links host are installation-wide and belong to no workspace (#480). */
function reservedHosts(ctx: CommandContext): Set<string> {
  const hosts = new Set<string>(ctx.services.reservedDomainHosts ?? []);
  for (const value of [ctx.services.linksUrl, ctx.services.publicUrl]) {
    if (!value) continue;
    try {
      hosts.add(normalizeHost(new URL(value).hostname));
    } catch {
      // A malformed setting is the server's problem, not this command's: skip it.
    }
  }
  return hosts;
}

export function assertHostRegistrable(ctx: CommandContext, target: { host: string }) {
  if (reservedHosts(ctx).has(target.host))
    throw new AppError(
      'invalid_input',
      `The host ${target.host} is reserved for this installation's admin or fallback links and cannot be registered as a brand domain. Use a hostname that serves only this brand.`,
    );
}

/** How long an unverified claim holds its hostname before another workspace may reclaim it (#467). */
export const PENDING_CLAIM_DAYS = 7;
const PENDING_CLAIM_MS = PENDING_CLAIM_DAYS * 24 * 60 * 60 * 1000;

interface HostClaim {
  workspaceId: string;
  status: string;
  createdAt: Date;
}

function adminDb(ctx: CommandContext) {
  const db = ctx.services.db;
  if (!db) throw new AppError('conflict', 'Domain registration needs the server database service.');
  return db;
}

/** Every row on a hostname, across workspaces; resolution is installation-wide, so are claims. */
async function hostClaims(ctx: CommandContext, host: string): Promise<HostClaim[]> {
  const { rows } = await adminDb(ctx).admin.query<HostClaim>(
    `SELECT workspace_id AS "workspaceId", status, created_at AS "createdAt" FROM workspace_domains WHERE host = $1`,
    [host],
  );
  return rows;
}

const claimExpired = (claim: HostClaim) => claim.status === 'pending' && claim.createdAt.getTime() <= Date.now() - PENDING_CLAIM_MS;

/**
 * A hostname belongs to one workspace (#462, #479): another workspace's verified row blocks it
 * forever, and another workspace's pending claim blocks it until that claim expires (#467).
 */
async function assertHostNotClaimed(ctx: CommandContext, target: { host: string }) {
  const foreign = (await hostClaims(ctx, target.host)).filter((claim) => claim.workspaceId !== ctx.principal.workspaceId);
  const verified = foreign.find((claim) => claim.status === 'verified');
  if (verified)
    throw new AppError(
      'invalid_input',
      `The host ${target.host} is verified by another workspace. A hostname belongs to one brand; choose a different host.`,
    );
  const pending = foreign.find((claim) => !claimExpired(claim));
  if (pending)
    throw new AppError(
      'invalid_input',
      `The host ${target.host} is claimed by another workspace. A pending claim can be reclaimed after ${PENDING_CLAIM_DAYS} days, or choose a different host.`,
    );
}

/**
 * Deletes an expired pending claim on the exact host and prefix, so a workspace can take over a
 * hostname that was claimed and abandoned (#467). Verified rows never expire.
 */
export async function reclaimExpiredClaim(ctx: CommandContext, target: { host: string; pathPrefix: string | null }) {
  const db = adminDb(ctx);
  const cutoff = new Date(Date.now() - PENDING_CLAIM_MS);
  await db.admin.query(
    `DELETE FROM workspace_domains
      WHERE host = $1 AND COALESCE(path_prefix, '') = COALESCE($2, '')
        AND status = 'pending' AND created_at <= $3`,
    [target.host, target.pathPrefix, cutoff],
  );
}

/** The checks every new or moved domain runs before it can hold a hostname. */
export async function assertDomainAvailable(ctx: CommandContext, target: { host: string; pathPrefix: string | null }) {
  assertHostRegistrable(ctx, target);
  await reclaimExpiredClaim(ctx, target);
  await assertHostNotClaimed(ctx, target);
}

/** Verification re-checks ownership: the other workspace may have verified the host since (#462). */
export async function assertDomainVerifiable(ctx: CommandContext, existing: { host: string; pathPrefix: string | null }) {
  assertHostRegistrable(ctx, existing);
  await assertHostNotClaimed(ctx, existing);
}

export const listWorkspaceDomains = defineCommand({
  name: 'workspace.domains.list',
  title: 'Brand domains',
  description:
    'The hostnames this workspace’s public links answer on, its primary domain and the effective links URL. A workspace without a domain uses the installation links URL (PUBLIC_LINKS_URL).',
  input: z.object({}),
  output: z.object({
    domains: z.array(DomainViewSchema),
    linksUrl: z.string().describe('Origin and prefix public links use: the primary domain, else PUBLIC_LINKS_URL'),
  }),
  permission: 'workspace:admin',
  effect: 'read',
  humansOnly: true,
  auditReads: true,
  handler: async (_input, ctx) => {
    const domains = await ctx.tx
      .select()
      .from(schema.workspaceDomains)
      .orderBy(desc(schema.workspaceDomains.isPrimary), asc(schema.workspaceDomains.host));
    return { domains: domainIdList(domains), linksUrl: await effectiveLinksUrl(ctx, domains) };
  },
});

export const addWorkspaceDomain = defineCommand({
  name: 'workspace.domains.add',
  title: 'Add a brand domain',
  description:
    'Admins: register a hostname (and optional path prefix such as /am) that serves this workspace’s public links. Use https, or http only on localhost. A hostname or prefix already registered by another workspace is rejected; one domain per workspace may be primary. A new domain starts pending and is not used until workspace.domains.verify succeeds.',
  input: z
    .object({
      host: z.string().trim().min(1).describe('Hostname, e.g. links.example.com or https://links.example.com'),
      pathPrefix: z.string().nullable().optional().describe('Optional path prefix such as /am; null or "/" means the whole host'),
      isPrimary: z.boolean().optional().describe('Make this the workspace’s primary domain (links URL once verified)'),
    })
    .strict(),
  output: z.object({ domain: DomainViewSchema }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.host,
  handler: async (input, ctx) => {
    const target = normalized(input);
    await assertDomainAvailable(ctx, target);
    if (input.isPrimary) await assertNoOtherPrimary(ctx);
    try {
      const [row] = await ctx.tx
        .insert(schema.workspaceDomains)
        .values({
          id: newId('wdo'),
          workspaceId: ctx.principal.workspaceId,
          host: target.host,
          pathPrefix: target.pathPrefix,
          isPrimary: input.isPrimary ?? false,
          status: 'pending',
          verificationToken: newId('wdv'),
          verifiedAt: null,
          createdBy: ctx.principal.userId,
        })
        .returning();
      invalidateResolver(ctx);
      return { domain: domainView(row) };
    } catch (err) {
      return mapUniqueViolation(err);
    }
  },
});

export const updateWorkspaceDomain = defineCommand({
  name: 'workspace.domains.update',
  title: 'Update a brand domain',
  description:
    'Admins: change a registered domain’s hostname, path prefix or primary flag. Changing the host or prefix resets a verified domain to pending, so verify it again. Only one primary domain is allowed; pending domains do not serve links. Verification is only ever done with workspace.domains.verify.',
  input: z
    .object({
      id: z.string().min(1),
      host: z.string().trim().min(1).optional(),
      pathPrefix: z.string().nullable().optional().describe('null clears the prefix; omit to keep it'),
      isPrimary: z.boolean().optional(),
    })
    .strict()
    .refine(
      (input) => input.host !== undefined || input.pathPrefix !== undefined || input.isPrimary !== undefined,
      'Give a host, pathPrefix or isPrimary to change.',
    ),
  output: z.object({ domain: DomainViewSchema }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const [existing] = await ctx.tx.select().from(schema.workspaceDomains).where(eq(schema.workspaceDomains.id, input.id)).limit(1);
    if (!existing) throw new AppError('not_found', 'This domain is not registered in this workspace.');

    const changes: Partial<typeof schema.workspaceDomains.$inferInsert> = {};
    if (input.host !== undefined || input.pathPrefix !== undefined) {
      const target = normalized({
        host: input.host ?? existing.host,
        pathPrefix: input.pathPrefix === undefined ? existing.pathPrefix : input.pathPrefix,
      });
      await assertDomainAvailable(ctx, target);
      changes.host = target.host;
      changes.pathPrefix = target.pathPrefix;
    }
    if (input.isPrimary !== undefined) {
      if (input.isPrimary) await assertNoOtherPrimary(ctx, existing.id);
      changes.isPrimary = input.isPrimary;
    }
    if (changes.host !== undefined || changes.pathPrefix !== undefined) {
      // A domain that now points somewhere else is no longer verified at the old name.
      changes.status = 'pending';
      changes.verifiedAt = null;
      changes.verificationToken = newId('wdv');
    }

    try {
      const [row] = await ctx.tx.update(schema.workspaceDomains).set(changes).where(eq(schema.workspaceDomains.id, input.id)).returning();
      if (!row) throw new AppError('not_found', 'This domain is not registered in this workspace.');
      invalidateResolver(ctx);
      return { domain: domainView(row) };
    } catch (err) {
      return mapUniqueViolation(err);
    }
  },
});

export const verifyWorkspaceDomain = defineCommand({
  name: 'workspace.domains.verify',
  title: 'Verify a brand domain',
  description:
    'Admins: prove a registered hostname reaches this installation, then use it for links and public pages. The server fetches https://<host><prefix>/.well-known/am-domain/<token> (http on localhost) and expects the token back; only verified domains are used for request resolution and links.',
  input: z.object({ id: z.string().min(1) }).strict(),
  output: z.object({ domain: DomainViewSchema, checkedUrl: z.string().describe('The challenge URL that was fetched') }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const [existing] = await ctx.tx.select().from(schema.workspaceDomains).where(eq(schema.workspaceDomains.id, input.id)).limit(1);
    if (!existing) throw new AppError('not_found', 'This domain is not registered in this workspace.');
    await assertDomainVerifiable(ctx, existing);
    const token = existing.verificationToken ?? newId('wdv');
    const url = `${originForHost(existing.host)}${existing.pathPrefix ?? ''}/.well-known/am-domain/${encodeURIComponent(token)}`;
    const fetchChallenge = ctx.services.fetchDomainChallenge;
    if (!fetchChallenge)
      throw new AppError(
        'conflict',
        'Domain verification needs the server’s egress-guarded fetch. Use workspace.domains.verify through the server.',
      );
    let checked: { status: number; body: string };
    try {
      checked = await fetchChallenge(url);
    } catch {
      // Reachability is deliberately not repeated: a private address, DNS failure or timeout must
      // not become an oracle against the server's network (#466).
      throw new AppError(
        'invalid_input',
        'Could not reach the domain’s verification challenge. Point the hostname at this installation (and its public listener) and try again.',
      );
    }
    if (checked.status !== 200)
      throw new AppError(
        'invalid_input',
        'The domain’s verification challenge did not return the expected token. Check that the hostname reaches this installation and that public paths are proxied unchanged.',
      );
    if (checked.body.trim() !== token)
      throw new AppError('invalid_input', 'The domain did not return this domain’s verification token. Another site may answer that host.');
    const [row] = await ctx.tx
      .update(schema.workspaceDomains)
      .set({ status: 'verified', verifiedAt: new Date(), verificationToken: token })
      .where(eq(schema.workspaceDomains.id, input.id))
      .returning();
    if (!row) throw new AppError('not_found', 'This domain is not registered in this workspace.');
    activateDomainRouting(ctx);
    return { domain: domainView(row), checkedUrl: url };
  },
});

export const removeWorkspaceDomain = defineCommand({
  name: 'workspace.domains.remove',
  title: 'Remove a brand domain',
  description:
    'Admins: remove a registered brand domain. Its public links fall back to the workspace’s other primary domain, or to PUBLIC_LINKS_URL when none is left.',
  input: z.object({ id: z.string().min(1) }).strict(),
  output: z.object({ removed: z.literal(true), id: z.string() }),
  permission: 'workspace:admin',
  effect: 'destructive',
  humansOnly: true,
  target: (input) => input.id,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.delete(schema.workspaceDomains).where(eq(schema.workspaceDomains.id, input.id)).returning();
    if (!row) throw new AppError('not_found', 'This domain is not registered in this workspace.');
    invalidateResolver(ctx);
    return { removed: true as const, id: row.id };
  },
});

export const workspaceDomainCommands = [
  listWorkspaceDomains,
  addWorkspaceDomain,
  updateWorkspaceDomain,
  verifyWorkspaceDomain,
  removeWorkspaceDomain,
] as const;
