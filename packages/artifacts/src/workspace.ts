import { type CommandContext, defineCommand, type Permission } from '@agentic-marketing/commands';
import { AppError, canonicalJson, newId, sha256 } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Requester, resolveActors } from './commands';

const Policy = z.enum(['none', 'agent_changes', 'all_publishes']);

const TIME_ZONES = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const TimeZone = z.string().describe('IANA time zone name, e.g. Europe/Copenhagen');

/** What a permission lets this principal do, under the workspace's current approval policy. */
function explainPermission(permission: Permission, policy: z.output<typeof Policy>, type: 'user' | 'agent'): string {
  switch (permission) {
    case 'artifacts:read':
      return 'Reads journeys, templates and other artifacts.';
    case 'artifacts:write':
      return 'Creates and edits drafts.';
    case 'artifacts:publish':
      if (policy === 'all_publishes')
        return 'Submits changes for review; a person approves them in the admin UI. Nobody publishes directly under this policy.';
      if (policy === 'agent_changes')
        return type === 'agent'
          ? 'Submits changes for review; a person approves them in the admin UI. You cannot publish directly.'
          : 'Publishes your own edits directly; changes written by an agent go to review for a person to approve in the admin UI.';
      return 'Publishes directly; this workspace has no approval step.';
    case 'artifacts:approve':
      return 'Approves or rejects changes in the admin UI. Agents can never use this.';
    case 'messages:send':
      return 'Sends e-mails and other messages to people. Consent, unsubscribes and suppressions are always enforced.';
    case 'audit:read':
      return 'Reads the audit log.';
    case 'profiles:read':
      return 'Reads customer profiles and events. Personal data stays hidden.';
    case 'profiles:pii':
      return 'Sees personal data in profiles, such as e-mail addresses.';
    case 'profiles:write':
      return 'Records consent and updates profile traits.';
    case 'profiles:erase':
      return 'Erases people. Agents can never use this.';
    case 'secrets:read':
      return 'Sees the names of stored secrets, never their values.';
    case 'secrets:write':
      return 'Stores and deletes secrets. Agents can never use this.';
    case 'workspace:admin':
      return 'Changes workspace settings. Agents can never use this.';
  }
}

export const getWorkspace = defineCommand({
  name: 'workspace.get',
  title: 'Current workspace',
  description:
    'The workspace you are acting in, its approval policy, time zone, test-send seed list, and your role and permissions explained.',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    approvalPolicy: Policy,
    timeZone: z.string().describe('IANA time zone of the workspace, e.g. Europe/Copenhagen'),
    seedList: z.array(z.string()).describe('Addresses (besides members) that test sends may go to'),
    serverVersion: z.string().describe('Version of the running server, e.g. 0.2.7'),
    you: z.object({ type: z.enum(['user', 'agent']), userId: z.string(), role: z.string(), permissions: z.array(z.string()) }),
    permissionsExplained: z
      .array(z.object({ permission: z.string(), meaning: z.string() }))
      .describe('What each of your permissions lets you do under the current approval policy'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const [w] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    const p = ctx.principal;
    const permissions = [...p.permissions].sort();
    return {
      id: w.id,
      name: w.name,
      approvalPolicy: w.approvalPolicy,
      timeZone: w.timeZone,
      seedList: w.seedList,
      serverVersion: ctx.services.serverVersion,
      you: { type: p.type, userId: p.userId, role: p.role, permissions },
      permissionsExplained: permissions.map((permission) => ({
        permission,
        meaning: explainPermission(permission, w.approvalPolicy, p.type),
      })),
    };
  },
});

const Adapter = z.enum(['smtp', 'ses', 'postmark', 'brevo', 'cloudflare', 'log']);
const Tracking = z.enum(['forced', 'configurable', 'none']);

// The e-mail package owns provider tracking details, but it depends on this one, so mirror the
// low-risk mapping here rather than introducing a cycle (v025-system-status.test.ts keeps them equal).
export const ADAPTER_TRACKING: Record<z.output<typeof Adapter>, z.output<typeof Tracking>> = {
  smtp: 'none',
  ses: 'configurable',
  postmark: 'configurable',
  brevo: 'forced',
  cloudflare: 'none',
  log: 'none',
};

export const getStatus = defineCommand({
  name: 'system.status',
  title: 'Server status',
  description:
    'The running server version, whether enabled e-mail providers cover marketing and transactional mail, and how many approval requests are waiting for a person. Read-only; it never returns provider addresses, hosts or secrets.',
  input: z.object({}),
  output: z.object({
    serverVersion: z.string().describe('Version of the running server, e.g. 0.2.7'),
    emailProvider: z.object({
      configured: z.boolean().describe('Whether an enabled provider covers both marketing and transactional mail'),
      marketing: z.boolean().describe('Whether an enabled provider is assigned to marketing mail'),
      transactional: z.boolean().describe('Whether an enabled provider is assigned to transactional mail'),
      adapter: Adapter.nullable().describe('Adapter of the marketing provider, else the transactional one'),
      tracking: Tracking.nullable().describe('Whether that provider adds open and click tracking itself'),
    }),
    pendingApprovals: z.number().int().describe('Approval requests waiting for a person to decide'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const providers = await ctx.tx
      .select({ adapter: schema.emailProviders.adapter, useFor: schema.emailProviders.useFor })
      .from(schema.emailProviders)
      .where(eq(schema.emailProviders.enabled, true))
      .orderBy(schema.emailProviders.createdAt);
    const marketing = providers.find((p) => p.useFor.includes('marketing'));
    const transactional = providers.find((p) => p.useFor.includes('transactional'));
    const shown = marketing ?? transactional;
    const [pending] = await ctx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.status, 'pending'));
    return {
      serverVersion: ctx.services.serverVersion,
      emailProvider: {
        configured: !!marketing && !!transactional,
        marketing: !!marketing,
        transactional: !!transactional,
        adapter: shown?.adapter ?? null,
        tracking: shown ? ADAPTER_TRACKING[shown.adapter] : null,
      },
      pendingApprovals: pending?.count ?? 0,
    };
  },
});

export const inputWarnings = defineCommand({
  name: 'system.inputWarnings',
  title: 'Unknown command inputs by client',
  description:
    'Command input keys that clients sent and the API ignored, per client, with first/last seen and counts. Use it to fix your own calls or to decide whether STRICT_INPUTS is safe to turn on. An API token or OAuth agent sees only its own rows; a person sees their own and their tokens’; workspace admins see every client. Only key paths are stored, never the values. `safeToEnableStrict` is true when no visible client sent an unknown key in the last 7 days, and `strictInputs` reports whether this server already rejects them.',
  input: z.object({
    sinceDays: z.number().int().min(1).max(365).default(30).describe('How many days back to include (default 30; rows are kept for 30)'),
  }),
  output: z.object({
    sinceDays: z.number().int().describe('The window these rows cover'),
    strictInputs: z.boolean().describe('Whether this server rejects unknown input keys (STRICT_INPUTS)'),
    safeToEnableStrict: z
      .boolean()
      .describe('True when no visible client sent an unknown key in the last 7 days, so strict mode would reject nothing'),
    clients: z.array(
      z.object({
        principalType: z.enum(['user', 'token', 'oauth_client']).describe('What identified the client'),
        principalId: z.string().describe('Token id, user id or OAuth client id'),
        clientLabel: z.string().describe('Token name, person name or e-mail, or OAuth client name'),
        quietDays: z.number().int().describe('Days since this client last sent an unknown key'),
        lastSeen: z.string().describe('When this client last sent an unknown key (ISO 8601)'),
        total: z.number().int().describe('How many unknown keys this client sent in the window'),
        commands: z.array(
          z.object({
            command: z.string().describe('Command the client called'),
            keys: z.array(
              z.object({
                keyPath: z.string().describe('Dotted path of the key the input schema does not accept'),
                count: z.number().int().describe('How many times the client sent it'),
                firstSeen: z.string().describe('First time it was seen (ISO 8601)'),
                lastSeen: z.string().describe('Last time it was seen (ISO 8601)'),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const p = ctx.principal;
    // Agents see their own client; people see their own rows and their tokens'; admins see all.
    const visible =
      p.type === 'agent'
        ? p.clientId?.startsWith('token:')
          ? and(eq(schema.inputWarnings.principalType, 'token'), eq(schema.inputWarnings.principalId, p.clientId.slice('token:'.length)))
          : and(eq(schema.inputWarnings.principalType, 'oauth_client'), eq(schema.inputWarnings.principalId, p.clientId ?? p.userId))
        : p.permissions.has('workspace:admin')
          ? undefined
          : or(
              and(eq(schema.inputWarnings.principalType, 'user'), eq(schema.inputWarnings.principalId, p.userId)),
              and(
                eq(schema.inputWarnings.principalType, 'token'),
                inArray(
                  schema.inputWarnings.principalId,
                  ctx.tx.select({ id: schema.apiTokens.id }).from(schema.apiTokens).where(eq(schema.apiTokens.userId, p.userId)),
                ),
              ),
            );

    const since = new Date(Date.now() - input.sinceDays * 86_400_000);
    const rows = await ctx.tx
      .select()
      .from(schema.inputWarnings)
      .where(and(visible, gte(schema.inputWarnings.lastSeen, since)))
      .orderBy(schema.inputWarnings.command, schema.inputWarnings.keyPath);
    const recent = await ctx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.inputWarnings)
      .where(and(visible, gte(schema.inputWarnings.lastSeen, new Date(Date.now() - 7 * 86_400_000))));

    const clients = new Map<
      string,
      {
        principalType: 'user' | 'token' | 'oauth_client';
        principalId: string;
        clientLabel: string;
        lastSeen: Date;
        total: number;
        commands: Map<string, { keyPath: string; count: number; firstSeen: Date; lastSeen: Date }[]>;
      }
    >();
    for (const row of rows) {
      const key = `${row.principalType}|${row.principalId}`;
      const client = clients.get(key) ?? {
        principalType: row.principalType,
        principalId: row.principalId,
        clientLabel: row.clientLabel,
        lastSeen: row.lastSeen,
        total: 0,
        commands: new Map(),
      };
      client.lastSeen = row.lastSeen > client.lastSeen ? row.lastSeen : client.lastSeen;
      client.total += row.count;
      const keys = client.commands.get(row.command) ?? [];
      keys.push({ keyPath: row.keyPath, count: row.count, firstSeen: row.firstSeen, lastSeen: row.lastSeen });
      client.commands.set(row.command, keys);
      clients.set(key, client);
    }

    return {
      sinceDays: input.sinceDays,
      strictInputs: ctx.services.strictInputs,
      safeToEnableStrict: (recent[0]?.count ?? 0) === 0,
      clients: [...clients.values()]
        .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
        .map((client) => ({
          ...client,
          quietDays: Math.floor((Date.now() - client.lastSeen.getTime()) / 86_400_000),
          lastSeen: client.lastSeen.toISOString(),
          commands: [...client.commands]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([command, keys]) => ({
              command,
              keys: keys
                .sort((a, b) => b.count - a.count || a.keyPath.localeCompare(b.keyPath))
                .map((k) => ({ ...k, firstSeen: k.firstSeen.toISOString(), lastSeen: k.lastSeen.toISOString() })),
            })),
        })),
    };
  },
});

const WorkspaceName = z.string().trim().min(1).max(120);

/** The admin UI page for a workspace proposal (only SERVICES with a public URL can build absolute links). */
const proposalUrl = (publicUrl: string | undefined, proposalId: string) =>
  publicUrl ? `${publicUrl}/approvals?proposal=${proposalId}` : null;

function assertTimeZone(timeZone: string) {
  if (!TIME_ZONES.has(timeZone)) throw new AppError('invalid_input', 'timeZone must be an IANA time zone name, e.g. Europe/Copenhagen.');
}

/** Applies setting changes the same way for a person's direct edit and an approved agent proposal. */
async function applyWorkspaceChanges(ctx: CommandContext, changes: { name?: string; timeZone?: string }) {
  const [w] = await ctx.tx.update(schema.workspaces).set(changes).where(eq(schema.workspaces.id, ctx.principal.workspaceId)).returning();
  if (!w) throw new AppError('not_found', 'This workspace does not exist any more.');
  return { id: w.id, name: w.name, timeZone: w.timeZone };
}

export const updateWorkspace = defineCommand({
  name: 'workspace.update',
  title: 'Update workspace',
  description:
    'Admins: change the workspace name or its display time zone (an IANA name such as Europe/Copenhagen; dates are shown in it).',
  input: z
    .object({
      name: WorkspaceName.optional().describe('New workspace name'),
      timeZone: TimeZone.optional().describe('IANA time zone, e.g. Europe/Copenhagen'),
    })
    .refine((input) => input.name !== undefined || input.timeZone !== undefined, 'Give a new name, timeZone, or both.'),
  output: z.object({ id: z.string(), name: z.string(), timeZone: z.string() }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    if (input.timeZone !== undefined) assertTimeZone(input.timeZone);
    return applyWorkspaceChanges(ctx, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    });
  },
});

const ProposalChange = z.object({
  from: z.string().describe('The value before the proposal'),
  to: z.string().describe('The value the proposal asks for'),
});
const ProposalChanges = z.object({
  name: ProposalChange.optional(),
  timeZone: ProposalChange.optional(),
});
const ProposalStatus = z.enum(['pending', 'approved', 'rejected', 'superseded']);
const ProposalOut = z.object({
  id: z.string(),
  changes: ProposalChanges,
  note: z.string(),
  status: ProposalStatus,
  requester: Requester,
  decidedBy: z.object({ id: z.string(), name: z.string() }).nullable().describe('The person who approved or rejected it'),
  decisionNote: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  reviewUrl: z.string().nullable().describe('Admin UI page where a person decides this proposal'),
});

type ProposalField = 'name' | 'timeZone';

/** Turns stored diffs into the values to set, ignoring a field that is absent. */
function proposalValues(changes: z.output<typeof ProposalChanges>) {
  return {
    ...(changes.name === undefined ? {} : { name: changes.name.to }),
    ...(changes.timeZone === undefined ? {} : { timeZone: changes.timeZone.to }),
  };
}

export const proposeWorkspaceUpdate = defineCommand({
  name: 'workspace.proposeUpdate',
  title: 'Propose a workspace setting change',
  description:
    'Agents and people with artifacts:write can propose low-risk workspace settings for a person to approve: the name and the display time zone (an IANA name such as Europe/Copenhagen). Use it instead of workspace.update, which needs workspace:admin. A newer pending proposal for the same setting supersedes the older one. A person approves or rejects it in the admin UI; nothing changes until then.',
  input: z
    .object({
      name: WorkspaceName.optional().describe('Proposed workspace name'),
      timeZone: TimeZone.optional().describe('Proposed IANA time zone, e.g. Europe/Copenhagen'),
      note: z.string().trim().min(1).max(1000).describe('Why this change, for the reviewer'),
    })
    .strict(),
  output: z.object({
    proposalId: z.string(),
    status: z.literal('pending'),
    changes: ProposalChanges,
    reviewUrl: z.string().nullable().describe('Admin UI approvals page where a person decides this proposal'),
    next: z.string().describe('What happens next, and how to check the result'),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  handler: async (input, ctx) => {
    if (input.name === undefined && input.timeZone === undefined)
      throw new AppError('invalid_input', 'Give a new name, timeZone, or both; nothing would change.');
    if (input.timeZone !== undefined) assertTimeZone(input.timeZone);
    const [w] = await ctx.tx
      .select({ name: schema.workspaces.name, timeZone: schema.workspaces.timeZone })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    if (!w) throw new AppError('not_found', 'This workspace does not exist any more.');

    const changes: z.output<typeof ProposalChanges> = {
      ...(input.name === undefined || input.name === w.name ? {} : { name: { from: w.name, to: input.name } }),
      ...(input.timeZone === undefined || input.timeZone === w.timeZone ? {} : { timeZone: { from: w.timeZone, to: input.timeZone } }),
    };
    const fields = Object.keys(changes) as ProposalField[];
    if (!fields.length) throw new AppError('invalid_input', 'Nothing would change: the workspace already has these settings.');

    // Only proposals that touch one of these settings are superseded, so a separate pending
    // proposal for another setting is left alone.
    const pending = await ctx.tx
      .select({ id: schema.workspaceProposals.id, changes: schema.workspaceProposals.changes })
      .from(schema.workspaceProposals)
      .where(and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceProposals.status, 'pending')));
    const superseded = pending
      .filter((p) => fields.some((field) => (p.changes as Record<string, unknown>)[field] !== undefined))
      .map((p) => p.id);
    if (superseded.length) {
      await ctx.tx
        .update(schema.workspaceProposals)
        .set({ status: 'superseded' })
        .where(
          and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), inArray(schema.workspaceProposals.id, superseded)),
        );
    }

    const proposalId = newId('wsp');
    await ctx.tx.insert(schema.workspaceProposals).values({
      workspaceId: ctx.principal.workspaceId,
      id: proposalId,
      changes,
      note: input.note,
      status: 'pending',
      requestedByType: ctx.principal.type,
      requestedById: ctx.principal.userId,
      requestedByClient: ctx.principal.clientId ?? null,
    });
    const reviewUrl = proposalUrl(ctx.services.publicUrl, proposalId);
    return {
      proposalId,
      status: 'pending' as const,
      changes,
      reviewUrl,
      next: reviewUrl
        ? `A person must approve this in the admin UI: ${reviewUrl}. Check the result with workspace.proposals.`
        : 'A person must approve this in the admin UI. Check the result with workspace.proposals.',
    };
  },
});

export const listWorkspaceProposals = defineCommand({
  name: 'workspace.proposals',
  title: 'List workspace setting proposals',
  description:
    'Workspace setting changes agents and people proposed, newest first (default: pending). Shows the diff (for example UTC → Europe/Copenhagen), the note, who asked and, once decided, who decided and why. Any reader can see them; only admins decide.',
  input: z.object({
    status: ProposalStatus.default('pending').describe('Which proposals to list'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ proposals: z.array(ProposalOut) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.workspaceProposals)
      .where(and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceProposals.status, input.status)))
      .orderBy(desc(schema.workspaceProposals.createdAt))
      .limit(input.limit);
    const requesters = await resolveActors(
      ctx,
      rows.map((r) => ({ key: r.id, type: r.requestedByType, id: r.requestedById, client: r.requestedByClient })),
    );
    const deciders = await resolveActors(
      ctx,
      rows
        .filter((r) => r.decidedBy !== null)
        .map((r) => ({ key: `decided:${r.id}`, type: 'user' as const, id: r.decidedBy!, client: null })),
    );
    return {
      proposals: rows.map((r) => ({
        id: r.id,
        changes: r.changes as z.output<typeof ProposalChanges>,
        note: r.note,
        status: r.status,
        requester: requesters.get(r.id)!,
        decidedBy: r.decidedBy ? { id: r.decidedBy, name: deciders.get(`decided:${r.id}`)?.displayName ?? r.decidedBy } : null,
        decisionNote: r.decisionNote,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        reviewUrl: proposalUrl(ctx.services.publicUrl, r.id),
      })),
    };
  },
});

export const approveWorkspaceProposal = defineCommand({
  name: 'workspace.approveProposal',
  title: 'Approve a workspace setting change',
  description:
    'Admins: approve a pending workspace setting proposal and apply it at once. The diff is applied as written; if the setting already has the proposed value it is marked approved without changing anything.',
  input: z.object({
    proposalId: z.string(),
    note: z.string().trim().max(1000).optional().describe('Optional note for the requester'),
  }),
  output: z.object({
    proposalId: z.string(),
    status: z.literal('approved'),
    workspace: z.object({ id: z.string(), name: z.string(), timeZone: z.string() }),
  }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.proposalId,
  handler: async (input, ctx) => {
    const [p] = await ctx.tx
      .select()
      .from(schema.workspaceProposals)
      .where(and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceProposals.id, input.proposalId)))
      .for('update');
    if (!p) throw new AppError('not_found', `Workspace proposal ${input.proposalId} does not exist in this workspace.`);
    if (p.status !== 'pending') throw new AppError('conflict', `This proposal was already ${p.status}.`);
    const workspace = await applyWorkspaceChanges(ctx, proposalValues(p.changes as z.output<typeof ProposalChanges>));
    await ctx.tx
      .update(schema.workspaceProposals)
      .set({ status: 'approved', decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: input.note ?? null })
      .where(and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceProposals.id, p.id)));
    return { proposalId: p.id, status: 'approved' as const, workspace };
  },
});

export const rejectWorkspaceProposal = defineCommand({
  name: 'workspace.rejectProposal',
  title: 'Reject a workspace setting change',
  description:
    'Admins: reject a pending workspace setting proposal. Nothing changes; the requester sees your reason in workspace.proposals. Tell them what to propose instead.',
  input: z.object({
    proposalId: z.string(),
    note: z.string().trim().min(1).max(1000).describe('Tell the requester what to change'),
  }),
  output: z.object({ proposalId: z.string(), status: z.literal('rejected') }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  target: (i) => i.proposalId,
  handler: async (input, ctx) => {
    const [p] = await ctx.tx
      .select()
      .from(schema.workspaceProposals)
      .where(and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceProposals.id, input.proposalId)))
      .for('update');
    if (!p) throw new AppError('not_found', `Workspace proposal ${input.proposalId} does not exist in this workspace.`);
    if (p.status !== 'pending') throw new AppError('conflict', `This proposal was already ${p.status}.`);
    await ctx.tx
      .update(schema.workspaceProposals)
      .set({ status: 'rejected', decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: input.note })
      .where(and(eq(schema.workspaceProposals.workspaceId, ctx.principal.workspaceId), eq(schema.workspaceProposals.id, p.id)));
    return { proposalId: p.id, status: 'rejected' as const };
  },
});

export const setSeedList = defineCommand({
  name: 'workspace.setSeedList',
  title: 'Set the test-send seed list',
  description:
    'Admins: replace the list of e-mail addresses (besides workspace members) that templates.sendTest and broadcasts.sendTest may send to. Use it for monitoring inboxes. At most 50 addresses; does not affect real broadcasts. Only people can change it.',
  input: z.object({
    seedList: z.array(z.email().max(320)).max(50).describe('E-mail addresses allowed to receive test sends'),
  }),
  output: z.object({ seedList: z.array(z.string()) }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    const seedList = [...new Set(input.seedList.map((e) => e.trim().toLowerCase()))];
    await ctx.tx.update(schema.workspaces).set({ seedList }).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    return { seedList };
  },
});

export const setApprovalPolicy = defineCommand({
  name: 'workspace.setApprovalPolicy',
  title: 'Set approval policy',
  description:
    'none: publish directly (single-person teams). agent_changes: anything an agent wrote needs a person to approve. all_publishes: every publish needs approval by someone other than the requester.',
  input: z.object({ policy: Policy }),
  output: z.object({ approvalPolicy: Policy }),
  permission: 'workspace:admin',
  effect: 'write',
  humansOnly: true,
  handler: async (input, ctx) => {
    await ctx.tx.update(schema.workspaces).set({ approvalPolicy: input.policy }).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
    return { approvalPolicy: input.policy };
  },
});

const AuditEntry = z.object({
  seq: z.number(),
  at: z.string(),
  principalType: z.string(),
  principalId: z.string(),
  clientId: z.string().nullable(),
  surface: z.string(),
  command: z.string(),
  effect: z.string(),
  target: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  actorName: z.string().optional().describe('Who ran it: a person, an API token (with owner) or an OAuth client'),
});

export const listAudit = defineCommand({
  name: 'audit.list',
  title: 'Read audit log',
  description: 'Who ran which command, through which surface, on what, and whether it succeeded. Newest first; page with `beforeSeq`.',
  input: z.object({
    limit: z.number().int().min(1).max(500).default(100),
    beforeSeq: z.number().int().optional(),
    target: z.string().optional().describe('Only entries about this object, e.g. an artifact id'),
  }),
  output: z.object({ entries: z.array(AuditEntry) }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.auditLog)
      .where(
        and(
          input.beforeSeq ? lt(schema.auditLog.seq, input.beforeSeq) : undefined,
          input.target ? eq(schema.auditLog.target, input.target) : undefined,
        ),
      )
      .orderBy(desc(schema.auditLog.seq))
      .limit(input.limit);
    const names = await resolveActors(
      ctx,
      rows.map((r) => ({
        key: String(r.seq),
        type: r.principalType === 'agent' ? 'agent' : 'user',
        id: r.principalId,
        client: r.clientId,
      })),
    );
    return {
      entries: rows.map((r) => ({
        actorName: names.get(String(r.seq))?.displayName,
        seq: r.seq,
        at: r.at.toISOString(),
        principalType: r.principalType,
        principalId: r.principalId,
        clientId: r.clientId,
        surface: r.surface,
        command: r.command,
        effect: r.effect,
        target: r.target,
        ok: r.ok,
        error: r.error,
      })),
    };
  },
});

export const verifyAudit = defineCommand({
  name: 'audit.verify',
  title: 'Verify audit log integrity',
  description: 'Recompute the hash chain of this workspace’s audit log and report the first entry that does not match, if any.',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), entries: z.number().int(), firstBrokenSeq: z.number().int().nullable() }),
  permission: 'audit:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const rows = await ctx.tx.select().from(schema.auditLog).orderBy(schema.auditLog.seq);
    let prev: string | null = null;
    for (const r of rows) {
      const entry = {
        workspaceId: r.workspaceId,
        principalType: r.principalType,
        principalId: r.principalId,
        clientId: r.clientId,
        surface: r.surface,
        command: r.command,
        effect: r.effect,
        target: r.target,
        inputHash: r.inputHash,
        ok: r.ok,
        error: r.error,
        prevHash: r.prevHash,
      };
      if (r.prevHash !== prev || r.hash !== sha256(canonicalJson(entry))) return { ok: false, entries: rows.length, firstBrokenSeq: r.seq };
      prev = r.hash;
    }
    return { ok: true, entries: rows.length, firstBrokenSeq: null };
  },
});

export const workspaceCommands = [
  getWorkspace,
  getStatus,
  inputWarnings,
  updateWorkspace,
  proposeWorkspaceUpdate,
  listWorkspaceProposals,
  approveWorkspaceProposal,
  rejectWorkspaceProposal,
  setSeedList,
  setApprovalPolicy,
  listAudit,
  verifyAudit,
] as const;
