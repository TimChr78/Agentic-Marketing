import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { DomainError, normalizeDomainInput, originForHost, schema } from '@agentic-marketing/db';
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

// Brand domains (#186): the hostnames a workspace's public links answer on. A brand is a
// workspace, so one row per hostname (and optional path prefix) is enough; the resolver reads the
// table across workspaces, while these commands edit only the caller's rows under RLS.

type DomainRow = typeof schema.workspaceDomains.$inferSelect;

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
      status: DomainStatus.optional().describe('pending (default) or verified; prefer workspace.domains.verify'),
    })
    .strict(),
  output: z.object({ domain: DomainViewSchema }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (input) => input.host,
  handler: async (input, ctx) => {
    const target = normalized(input);
    if (input.isPrimary) await assertNoOtherPrimary(ctx);
    const now = new Date();
    const status = input.status ?? 'pending';
    try {
      const [row] = await ctx.tx
        .insert(schema.workspaceDomains)
        .values({
          id: newId('wdo'),
          workspaceId: ctx.principal.workspaceId,
          host: target.host,
          pathPrefix: target.pathPrefix,
          isPrimary: input.isPrimary ?? false,
          status,
          verificationToken: status === 'verified' ? null : newId('wdv'),
          verifiedAt: status === 'verified' ? now : null,
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
    'Admins: change a registered domain’s hostname, path prefix, primary flag or verification status. Changing the host or prefix resets a verified domain to pending, so verify it again. Only one primary domain is allowed; pending domains do not serve links.',
  input: z
    .object({
      id: z.string().min(1),
      host: z.string().trim().min(1).optional(),
      pathPrefix: z.string().nullable().optional().describe('null clears the prefix; omit to keep it'),
      isPrimary: z.boolean().optional(),
      status: DomainStatus.optional().describe('pending or verified; prefer workspace.domains.verify'),
    })
    .strict()
    .refine(
      (input) => input.host !== undefined || input.pathPrefix !== undefined || input.isPrimary !== undefined || input.status !== undefined,
      'Give a host, pathPrefix, isPrimary or status to change.',
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
      changes.host = target.host;
      changes.pathPrefix = target.pathPrefix;
    }
    if (input.isPrimary !== undefined) {
      if (input.isPrimary) await assertNoOtherPrimary(ctx, existing.id);
      changes.isPrimary = input.isPrimary;
    }
    if (input.status !== undefined) {
      changes.status = input.status;
      changes.verifiedAt = input.status === 'verified' ? new Date() : null;
      if (input.status === 'pending' && !existing.verificationToken) changes.verificationToken = newId('wdv');
    } else if (changes.host !== undefined || changes.pathPrefix !== undefined) {
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
    const token = existing.verificationToken ?? newId('wdv');
    const url = `${originForHost(existing.host)}${existing.pathPrefix ?? ''}/.well-known/am-domain/${encodeURIComponent(token)}`;
    const fetchChallenge =
      ctx.services.fetchDomainChallenge ??
      (async (challenge: string) => {
        const res = await fetch(challenge, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
        return { status: res.status, body: await res.text() };
      });
    let checked: { status: number; body: string };
    try {
      checked = await fetchChallenge(url);
    } catch (err) {
      throw new AppError(
        'invalid_input',
        `Could not reach ${url}: ${(err as Error).message}. Point the hostname at this installation (and its public listener) and try again.`,
      );
    }
    if (checked.status !== 200)
      throw new AppError(
        'invalid_input',
        `${url} answered HTTP ${checked.status} instead of returning the verification token. Check that the hostname reaches this installation.`,
      );
    if (checked.body.trim() !== token)
      throw new AppError('invalid_input', `${url} did not return this domain’s verification token. Another site may answer that host.`);
    const [row] = await ctx.tx
      .update(schema.workspaceDomains)
      .set({ status: 'verified', verifiedAt: new Date(), verificationToken: token })
      .where(eq(schema.workspaceDomains.id, input.id))
      .returning();
    if (!row) throw new AppError('not_found', 'This domain is not registered in this workspace.');
    invalidateResolver(ctx);
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
