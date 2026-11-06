import { AppError, canonicalJson, hashValue, sha256 } from '@agentic-marketing/core';
import { type AgentUndo, type Db, schema, type Tx } from '@agentic-marketing/db';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type ActionClass,
  type AgentCounters,
  autonomySettings,
  decide,
  type Impact,
  type MandateView,
  type PolicyInput,
  type PolicyOutcome,
  REACH_CLASSES,
} from './policy';
import type { Permission, Principal } from './principal';
import { createUndoCollector, type UndoCollector } from './undo';
import { findUnknownInputKeys, type UnknownInputKey, unknownKeyMessages } from './unknownKeys';

// The command registry (ADR-0005): every capability is a command. REST, MCP and the typed UI
// client are generated from these definitions, and `execute` is the only way to run one, so
// validation, authorization, idempotency and audit cannot be skipped by any surface.

export type Effect = 'read' | 'write' | 'publish' | 'destructive';
export type Surface = 'rest' | 'mcp' | 'scim' | 'internal';

/** A public request's brand context (#185), attached by the server's public middleware. */
export interface PublicRequest {
  /** The workspace whose verified domain matched, or null on the PUBLIC_LINKS_URL fallback host. */
  workspaceId: string | null;
  /** The origin and path prefix this request is served on: its links base. */
  linksUrl: string;
  /** True when a registered domain matched; false on the installation fallback. */
  matched: boolean;
}

/** Extension point for dependencies commands need (key providers, clocks…). Packages augment it. */
export interface Services {
  /** Public URL of the server, e.g. for admin UI deep links in command output. */
  publicUrl?: string;
  /** Links host (PUBLIC_LINKS_URL), for shareable unsubscribe, form, web-version and archive URLs. */
  linksUrl?: string;
  /**
   * The links URL for one workspace: its verified primary brand domain, else `linksUrl` (#186).
   * Wired by the server; commands that build links for a specific workspace use this instead of the
   * global value.
   */
  linksUrlFor?: (workspaceId: string) => Promise<string>;
  /**
   * One outbound GET under the server's egress policy, used to check a brand domain's verification
   * challenge (#185). Timeboxed by the caller; tests may replace it.
   */
  fetchDomainChallenge?: (url: string) => Promise<{ status: number; body: string }>;
  /** Drop the host-resolver cache after a domain write (#186). */
  invalidateDomainCache?: () => void;
  /** Version of the running server, so command output can show it (workspace.get). */
  serverVersion: string;
  /** True when the person owns at least one workspace (#190); wired by the server's directory. */
  ownsAnyWorkspace?: (userId: string) => Promise<boolean>;
  /** Whether unknown input keys are rejected rather than warned about (STRICT_INPUTS). */
  strictInputs: boolean;
  /** Shared counter for wrong passwords on token widening (#61), so every process sees the lockout. */
  stepUpLimiter?: StepUpLimiter;
  /** The agent's active mandate (ADR-0016); registered by packages/artifacts through the server. */
  activeMandate?: (tx: Tx, agentId: string) => Promise<{ view: MandateView; outsideHours: string | null } | null>;
  /**
   * The independent check (ADR-0016, #231): a second model judges whether an autonomous action
   * matches the agent's intent and mandate. Registered by the server when AI providers exist; a
   * mandate that asks for it fails closed (to a person) when it is missing or errors.
   */
  independentCheck?: (
    tx: Tx,
    input: { principal: Principal; command: string; input: unknown; intent: string | null; policy: PolicyOutcome; mandate: MandateView },
  ) => Promise<{ ok: boolean; reason: string }>;
  /** What an agent's actions led to in a period (#310); registered by the server (metric layer, holdouts). */
  agentOutcomes?: (
    tx: Tx,
    workspaceId: string,
    agentId: string,
    range: { from: Date; to: Date },
    goals: { measure: string; target?: number; direction: 'up' | 'down' }[],
  ) => Promise<AgentOutcomes>;
  /** Why an agent's recent sends breach its mandate's guardrails, or null; registered by the server (metric layer). */
  mandateGuardrails?: (tx: Tx, workspaceId: string, agentId: string, mandate: MandateView) => Promise<string | null>;
}

/** Outcomes of an agent's actions (#310): its sends, its journeys against holdouts, its goals. */
export interface AgentOutcomes {
  broadcasts: EmailOutcome | null;
  direct: EmailOutcome | null;
  journeys: { id: string; verdict: string | null; note: string }[];
  goals: { measure: string; target?: number; direction: 'up' | 'down'; value: number | null; met: boolean | null; note: string | null }[];
}
export interface EmailOutcome {
  count: number;
  sent: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  complained: number;
  bounced: number;
}

/** A failure counter shared by all processes, e.g. Valkey. Times are absolute so callers can explain the wait. */
export interface StepUpLimiter {
  /** When this person may try again, or null when they are not locked out. */
  lockedUntil(userId: string): Promise<Date | null>;
  /** Counts a wrong password and returns the lockout it started, if any. */
  recordFailure(userId: string): Promise<Date | null>;
  /** Forgets earlier failures after a correct password. */
  reset(userId: string): Promise<void>;
}

export interface CommandContext {
  principal: Principal;
  tx: Tx;
  services: Services;
  /** The surface the command came in on, for commands that append their own audit entries. */
  surface?: Surface;
  /** Runs `fn` once the command's transaction has committed (e.g. to invalidate caches); errors are logged, not thrown. */
  afterCommit?: (fn: () => Promise<void>) => void;
  /** The policy engine's decision for an agent write (ADR-0016). "ask" means the change must wait for a person. */
  policy?: PolicyOutcome;
  /**
   * How to reverse what this handler does (ADR-0016 §5.4). Set it where the change goes live; the
   * executor records it in the agent ledger. Only agent writes keep it.
   */
  undo?: UndoCollector;
}

export interface CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, N extends string = string> {
  name: N;
  title: string;
  description: string;
  input: I;
  output: O;
  /** null only for internal commands that are not in the public registry (e.g. accepting an invitation). */
  permission: Permission | null;
  /**
   * A second permission (never for agents) that also runs the command when `allows` confirms the input
   * only touches the caller, e.g. an approver test-sending to their own address.
   */
  selfService?: {
    permission: Permission;
    allows: (input: z.output<I>, principal: Principal) => boolean;
  };
  effect: Effect;
  /** Agents may never run it, whatever their scopes (approving, managing members…). */
  humansOnly?: boolean;
  /**
   * What the command changes in the world (ADR-0016, design §3.2). Required for every write an agent
   * may run (a registry test checks it); people-only commands default from `effect`.
   */
  actionClass?: ActionClass;
  /** Estimates what one call would do (people reached, class by artifact type), before it runs. */
  impact?: (input: z.output<I>, ctx: CommandContext) => Promise<Impact>;
  /** The command can wait for an approval when the policy engine says "ask" (it reads ctx.policy). */
  approvable?: boolean;
  /** Top-level input fields that must never be hashed into the audit log or idempotency store (secret values). */
  sensitive?: readonly string[];
  /** Top-level output fields shown once (e.g. an invitation token): an idempotent replay returns them redacted. */
  sensitiveOutput?: readonly string[];
  /** Audit successful calls of a read command too (e.g. reads of personal data). Writes and all failures are always audited. */
  auditReads?: boolean;
  /**
   * The handler appends its own audit entries (one per item it changed) instead of the executor
   * appending one for the whole call, e.g. agents.renewMandates (#428). A call that throws is still
   * audited by the executor.
   */
  auditsItself?: boolean;
  /** What the command acts on, for the audit log (e.g. an artifact id). */
  target?: (input: z.output<I>) => string | undefined;
  /**
   * What the audit log records as the target when the id is only known after the handler ran, e.g.
   * a freshly created token or invitation. Falls back to `target` when it returns undefined.
   */
  auditTarget?: (output: z.output<O>) => string | undefined;
  /**
   * Facts about what the handler created, merged into the agent ledger's impact (#265). The
   * ledger is written after the handler so it can link the action to the rows it produced, e.g.
   * the message a direct send created, which guardrails need to find the agent's own sends.
   */
  ledgerImpact?: (output: z.output<O>) => Record<string, unknown> | undefined;
  handler: (input: z.output<I>, ctx: CommandContext) => Promise<z.input<O>>;
}

export function defineCommand<N extends string, I extends z.ZodType, O extends z.ZodType>(def: CommandDef<I, O, N>) {
  return def;
}

/** A command's class: declared, or derived from its effect for people-only commands. */
export function actionClassOf(cmd: Pick<AnyCommand, 'actionClass' | 'effect'>): ActionClass {
  if (cmd.actionClass) return cmd.actionClass;
  if (cmd.effect === 'read') return 'read';
  if (cmd.effect === 'destructive') return 'destructive';
  return 'settings';
}

/** The policy engine's refusal, with its reasons for the caller. */
export class PolicyDeniedError extends AppError {
  constructor(readonly outcome: PolicyOutcome) {
    super('forbidden', outcome.reasons.join(' '), { decision: 'deny', actionClass: outcome.actionClass, reasons: outcome.reasons });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous command lists
export type AnyCommand = CommandDef<any, any, string>;

export interface ExecuteOptions {
  surface: Surface;
  idempotencyKey?: string;
}

export interface ExecutorOptions {
  /** Reject unknown input keys instead of ignoring them with a warning (STRICT_INPUTS). */
  strictInputs?: boolean;
  /** Called with the unknown keys a non-strict executor ignored, e.g. to log and persist them. */
  onUnknownKeys?: (command: string, unknown: UnknownInputKey[], principal: Principal) => void;
  /**
   * Called once after every command execution, with its outcome, so a host can count and time
   * commands (e.g. the server's `/metrics`). Purely a callback: this package depends on no
   * metrics library, and a throwing callback never changes the command's result.
   */
  onCommand?: (event: { command: string; effect: Effect; outcome: 'ok' | 'error'; durationMs: number }) => void;
}

const tracer = trace.getTracer('@agentic-marketing/commands');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Adds the unknown-key warnings to a command result without overwriting a command's own warnings. */
function withInputWarnings<T>(out: T, messages: string[]): T {
  if (!messages.length || !isPlainObject(out)) return out;
  const existing = out.warnings;
  if (existing === undefined) return { ...out, warnings: messages };
  // Some commands (artifacts.create/updateDraft) use warnings for structured draft findings; keep those.
  if (Array.isArray(existing) && existing.every((warning) => typeof warning === 'string'))
    return { ...out, warnings: [...existing, ...messages] };
  return out;
}

function redact(input: unknown, fields?: readonly string[]) {
  if (!fields?.length || !input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fields.includes(k) ? '[redacted]' : v]));
}

/**
 * Appends one entry to a workspace's audit log, keeping its hash chain. The executor calls this for
 * every command; a command that records several items itself (agents.renewMandates, one per
 * mandate) calls it directly and declares `auditsItself`.
 */
export async function appendAuditEntry(
  tx: Tx,
  p: Principal,
  surface: Surface,
  cmd: { name: string; effect: string },
  inputHash: string,
  target: string | undefined,
  error?: AppError,
  ip?: string | null,
) {
  // Serialise appends per workspace so the hash chain never forks under concurrency.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${p.workspaceId}`}, 0))`);
  const [prev] = await tx
    .select({ hash: schema.auditLog.hash })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.workspaceId, p.workspaceId))
    .orderBy(desc(schema.auditLog.seq))
    .limit(1);
  const entry = {
    workspaceId: p.workspaceId,
    principalType: p.type,
    principalId: p.userId,
    clientId: p.clientId ?? null,
    surface,
    command: cmd.name,
    effect: cmd.effect,
    target: target ?? null,
    inputHash,
    ok: !error,
    error: error ? `${error.code}: ${error.message}` : null,
    prevHash: prev?.hash ?? null,
    ...(ip ? { ip } : {}),
  };
  await tx.insert(schema.auditLog).values({ ...entry, hash: sha256(canonicalJson(entry)) });
}

export function createExecutor(db: Db, services: Services, options: ExecutorOptions = {}) {
  const appendAudit = (
    tx: Tx,
    p: Principal,
    surface: Surface,
    cmd: AnyCommand,
    inputHash: string,
    target: string | undefined,
    error?: AppError,
  ) => appendAuditEntry(tx, p, surface, cmd, inputHash, target, error);

  /** Validate → authorize → idempotency → handler → validate output → audit (writes and failures), in one transaction. */
  async function execute<C extends AnyCommand>(
    cmd: C,
    rawInput: unknown,
    principal: Principal,
    opts: ExecuteOptions,
  ): Promise<z.output<C['output']>> {
    return tracer.startActiveSpan(`command ${cmd.name}`, async (span) => {
      span.setAttributes({
        'command.name': cmd.name,
        'command.effect': cmd.effect,
        'command.surface': opts.surface,
        'principal.type': principal.type,
      });
      const input = rawInput ?? {};
      const inputHash = hashValue(redact(input, cmd.sensitive));
      let target: string | undefined;
      const startedAt = Date.now();
      // Metrics or logging hooks are observers: they must never fail a command or mask its error.
      const report = (outcome: 'ok' | 'error') => {
        try {
          options.onCommand?.({ command: cmd.name, effect: cmd.effect, outcome, durationMs: Date.now() - startedAt });
        } catch {
          // Ignored on purpose.
        }
      };
      const unknown = findUnknownInputKeys(cmd.input, input);
      const unknownMessages = unknownKeyMessages(cmd.name, unknown);

      const fail = async (err: AppError): Promise<never> => {
        // The main transaction rolled back; record the failed attempt in its own.
        await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target, err));
        report('error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.code });
        span.end();
        throw err;
      };

      if (unknown.length) {
        if (options.strictInputs) return fail(new AppError('invalid_input', unknownMessages.join(' '), { unknownKeys: unknown }));
      }
      const parsed = cmd.input.safeParse(input);
      if (!parsed.success)
        return fail(new AppError('invalid_input', 'The input does not match the command schema.', z.treeifyError(parsed.error)));
      if (unknown.length) options.onUnknownKeys?.(cmd.name, unknown, principal);
      target = cmd.target?.(parsed.data);
      if (cmd.humansOnly && principal.type !== 'user')
        return fail(new AppError('forbidden', `${cmd.name} can only be run by a person, not by an agent.`));
      if (cmd.permission && !principal.permissions.has(cmd.permission)) {
        const selfService =
          principal.type === 'user' &&
          cmd.selfService !== undefined &&
          principal.permissions.has(cmd.selfService.permission) &&
          cmd.selfService.allows(parsed.data, principal);
        if (!selfService)
          return fail(
            new AppError(
              'forbidden',
              principal.type === 'agent'
                ? `This agent was not granted the "${cmd.permission}" permission. The person can grant it when connecting the agent.`
                : `Your role (${principal.role}) does not include the "${cmd.permission}" permission.`,
            ),
          );
      }

      const agent = principal.type === 'agent' ? principal.agent : undefined;
      if (agent && agent.status !== 'active')
        return fail(
          new AppError(
            'forbidden',
            `This agent (${agent.name}) is ${agent.status}${agent.statusReason ? `: ${agent.statusReason}` : ''}. ${
              agent.status === 'paused' ? 'A person can resume it in Settings → Agents.' : 'Its credentials no longer work.'
            }`,
          ),
        );

      const committed: (() => Promise<void>)[] = [];
      let policy: PolicyOutcome | undefined;
      try {
        const result = await retrySnapshotConflicts(cmd.effect === 'read', () =>
          db.withWorkspace(
            principal.workspaceId,
            async (tx) => {
              committed.length = 0;
              policy = undefined;
              // The agent was resolved when the request (or a hosted run) began; a pause or revoke
              // committed since then stops this command too (#275).
              if (agent) {
                const [current] = await tx
                  .select({ status: schema.agents.status, statusReason: schema.agents.statusReason })
                  .from(schema.agents)
                  .where(eq(schema.agents.id, agent.id));
                if (current && current.status !== 'active')
                  throw new AppError(
                    'forbidden',
                    `This agent (${agent.name}) is ${current.status}${current.statusReason ? `: ${current.statusReason}` : ''}. ${
                      current.status === 'paused' ? 'A person can resume it in Settings → Agents.' : 'Its credentials no longer work.'
                    }`,
                  );
              }
              // ADR-0016: every agent write passes the policy engine before the handler runs.
              if (agent && cmd.effect !== 'read') {
                const impact = cmd.impact ? await cmd.impact(parsed.data, { principal, tx, services }) : {};
                policy = await agentPolicy(tx, services, principal, {
                  command: cmd.name,
                  actionClass: impact.actionClass ?? actionClassOf(cmd),
                  impact,
                  approvable: cmd.approvable === true,
                  input: parsed.data,
                });
                if (policy.decision === 'deny') throw new PolicyDeniedError(policy);
              }
              if (opts.idempotencyKey) {
                const [hit] = await tx
                  .select()
                  .from(schema.idempotencyKeys)
                  .where(
                    and(eq(schema.idempotencyKeys.workspaceId, principal.workspaceId), eq(schema.idempotencyKeys.key, opts.idempotencyKey)),
                  );
                if (hit) {
                  if (hit.command !== cmd.name || hit.inputHash !== inputHash)
                    throw new AppError('conflict', 'This idempotency key was already used for a different request. Use a new key.');
                  return hit.response as z.output<C['output']>;
                }
              }
              const undo = createUndoCollector();
              const out = withInputWarnings(
                cmd.output.parse(
                  await cmd.handler(parsed.data, {
                    principal,
                    tx,
                    services,
                    surface: opts.surface,
                    policy,
                    undo,
                    afterCommit: (fn) => committed.push(fn),
                  }),
                ),
                unknownMessages,
              ) as z.output<C['output']>;
              // The handler ran: let it link the ledger row to what it created (e.g. a message id),
              // while the policy decision itself stays the one made before the change.
              if (agent && policy && cmd.ledgerImpact) {
                const extra = cmd.ledgerImpact(out);
                if (extra) policy = { ...policy, impact: { ...policy.impact, ...extra } };
              }
              if (opts.idempotencyKey)
                await tx.insert(schema.idempotencyKeys).values({
                  workspaceId: principal.workspaceId,
                  key: opts.idempotencyKey,
                  command: cmd.name,
                  inputHash,
                  response: redact(out, cmd.sensitiveOutput) as object,
                });
              if (cmd.effect !== 'read') target = cmd.auditTarget?.(out) ?? target;
              if (cmd.effect !== 'read' && !cmd.auditsItself) await appendAudit(tx, principal, opts.surface, cmd, inputHash, target);
              if (agent && policy)
                await recordAgentAction(tx, agent.id, cmd, policy, opts.surface, target, null, intentOf(parsed.data), undo.get());
              return out;
            },
            // Reads see one consistent snapshot; writes keep read-committed so their locks see the latest rows.
            { snapshot: cmd.effect === 'read' },
          ),
        );
        // An audited read is recorded in its own transaction: the hash chain must be appended under
        // its lock with the latest entries visible, which a snapshot taken earlier would not show.
        if (cmd.effect === 'read' && cmd.auditReads)
          await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target));
        for (const fn of committed) await fn().catch((err) => span.recordException(err as Error));
        report('ok');
        span.end();
        return result;
      } catch (err) {
        // The transaction rolled back: keep the agent's attempt (a refusal or a failed write) in the ledger.
        const outcome = policy;
        if (agent && outcome)
          await db
            .withWorkspace(principal.workspaceId, (tx) =>
              recordAgentAction(
                tx,
                agent.id,
                cmd,
                outcome,
                opts.surface,
                target,
                err instanceof Error ? err.message : String(err),
                intentOf(parsed.data),
              ),
            )
            .catch((e) => span.recordException(e as Error));
        if (err instanceof AppError) return fail(err);
        report('error');
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw err;
      }
    });
  }

  return { execute };
}

export type Executor = ReturnType<typeof createExecutor>;

/**
 * What the other agents have on the artifacts this action changes (#426), before the policy
 * engine decides: the owner of an artifact when it belongs to another agent, and any pending
 * change (a hold inside its veto window, or an open approval request) from a different agent.
 * The executor only calls this for changes beyond a draft; people never reach it. The artifact
 * rows are locked for update (in id order) so the decision and the write see the same owner, and
 * `artifacts.setOwner` cannot slip between them (#471).
 */
export async function coordinationFor(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  actionClass: ActionClass,
  impact: Impact,
): Promise<{ ownership: NonNullable<PolicyInput['ownership']> | null; conflicts: string[] }> {
  const touched = impact.touches?.artifacts ?? [];
  if (!touched.length || actionClass === 'draft' || actionClass === 'read') return { ownership: null, conflicts: [] };
  const ids = [...new Set(touched.map((a) => a.id))];
  const rows = await tx
    .select({ id: schema.artifacts.id, name: schema.artifacts.name, ownerAgentId: schema.artifacts.ownerAgentId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, workspaceId), inArray(schema.artifacts.id, ids)))
    .orderBy(asc(schema.artifacts.id))
    .for('update');
  const names = new Map(rows.map((a) => [a.id, a.name]));

  let ownership: NonNullable<PolicyInput['ownership']> | null = null;
  for (const a of rows) {
    if (!a.ownerAgentId || a.ownerAgentId === agentId) continue;
    const [owner] = await tx
      .select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, a.ownerAgentId)));
    const candidate: NonNullable<PolicyInput['ownership']> = {
      agentId: a.ownerAgentId,
      // A deleted owner is reported as retired; it never blocks.
      agentName: owner?.name ?? 'a retired agent',
      active: owner?.status === 'active',
      artifactId: a.id,
      artifactName: a.name,
    };
    // An active owner anywhere is the one worth explaining; keep the first if all are inactive.
    if (!ownership || (candidate.active && !ownership.active)) ownership = candidate;
    if (ownership.active) break;
  }

  // Pending approvals from another agent on the same artifacts: a hold still inside its veto
  // window, or an ordinary approval request. The requesting agent comes from the credential the
  // request recorded, exactly as resume/approval look it up.
  const pending = await tx.execute<{ artifact_id: string; hold_until: Date | string | null; agent_name: string }>(sql`
    SELECT ar.artifact_id, ar.hold_until, a.name AS agent_name
    FROM approval_requests ar
    JOIN agent_credentials c ON c.workspace_id = ar.workspace_id AND (
      (c.kind = 'api_token' AND ar.requested_by_client = 'token:' || c.credential_id)
      OR (c.kind = 'hosted' AND ar.requested_by_client = 'hosted:' || c.credential_id)
      OR (c.kind = 'copilot' AND ar.requested_by_client = 'copilot:' || c.credential_id)
      OR (c.kind = 'oauth_client' AND ar.requested_by_client = c.credential_id))
    JOIN agents a ON a.workspace_id = c.workspace_id AND a.id = c.agent_id
    WHERE ar.workspace_id = ${workspaceId}
      AND ar.status = 'pending' AND ar.requested_by_type = 'agent'
      AND ar.artifact_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND a.id <> ${agentId}
    ORDER BY ar.created_at`);
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const row of pending.rows) {
    const key = `${row.artifact_id}:${row.agent_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = names.get(row.artifact_id) ? `“${names.get(row.artifact_id)}”` : row.artifact_id;
    const until = row.hold_until ? new Date(row.hold_until) : null;
    const what =
      until && until > new Date()
        ? `a hold until ${until.toISOString()}`
        : until
          ? 'a hold whose veto window has ended and now waits for a person'
          : 'an open approval request';
    conflicts.push(`${label} already has ${what} from agent ${row.agent_name}.`);
  }
  return { ownership, conflicts };
}

/**
 * The policy decision for one agent write (ADR-0016): the workspace settings, the agent's active
 * mandate, its guardrails and counters, then the independent check. Used by the executor for
 * every command and by commands that publish on an agent's behalf (config.import, #239).
 *
 * Holds a per-agent transaction lock first, so two concurrent requests from the same agent
 * cannot both read counters below a limit and both run (#240): the second waits until the
 * first has committed its ledger row.
 */
export async function agentPolicy(
  tx: Tx,
  services: Services,
  principal: Principal,
  req: { command: string; actionClass: ActionClass; impact: Impact; approvable: boolean; input: unknown },
): Promise<PolicyOutcome> {
  const agent = principal.agent;
  if (!agent) throw new Error('agentPolicy needs an agent principal');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-policy:${principal.workspaceId}:${agent.id}`}, 0))`);
  const [ws] = await tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
  const [row] = await tx
    .select({ guard: schema.agents.guard, status: schema.agents.status, statusReason: schema.agents.statusReason })
    .from(schema.agents)
    .where(eq(schema.agents.id, agent.id));
  // Every decision sees the agent's current status, including the publishes inside one long
  // command such as config.import: a pause stops the rest (#292).
  if (row && row.status !== 'active')
    throw new AppError(
      'forbidden',
      `This agent (${agent.name}) is ${row.status}${row.statusReason ? `: ${row.statusReason}` : ''}. ${
        row.status === 'paused' ? 'A person can resume it in Settings → Agents.' : 'Its credentials no longer work.'
      }`,
    );
  const mandate = req.actionClass === 'read' ? null : ((await services.activeMandate?.(tx, agent.id)) ?? null);
  const guardrailBreach =
    mandate && REACH_CLASSES.includes(req.actionClass) && services.mandateGuardrails
      ? await services.mandateGuardrails(tx, principal.workspaceId, agent.id, mandate.view)
      : null;
  // Several agents in one workspace (#426): who owns the artifact, and what other agents have pending.
  const coordination = await coordinationFor(tx, principal.workspaceId, agent.id, req.actionClass, req.impact);
  let policy = decide({
    command: req.command,
    actionClass: req.actionClass,
    impact: req.impact,
    settings: autonomySettings(ws?.autonomy),
    counters: await agentCounters(tx, agent.id),
    approvable: req.approvable,
    guard: row?.guard ?? null,
    ...(coordination.ownership ? { ownership: coordination.ownership } : {}),
    ...(coordination.conflicts.length ? { conflicts: coordination.conflicts } : {}),
    ...(mandate ? { mandate: mandate.view, outsideHours: mandate.outsideHours, guardrailBreach } : {}),
  });
  // Only what the mandate lets run by itself (level 2+) is checked; drafts and proposals are not (#260).
  if (
    mandate &&
    policy.mandate?.independentCheck &&
    (policy.level ?? 0) >= 2 &&
    (policy.decision === 'allow' || policy.decision === 'hold')
  )
    policy = await withIndependentCheck(tx, services, policy, {
      principal,
      command: req.command,
      input: req.input,
      intent: intentOf(req.input),
      mandate: mandate.view,
      approvable: req.approvable,
    });
  return policy;
}

/** One agent write in the ledger (#218), with the decision that allowed, escalated or refused it. */
export async function recordAgentAction(
  tx: Tx,
  agentId: string,
  cmd: Pick<AnyCommand, 'name'>,
  policy: PolicyOutcome,
  surface: Surface,
  target: string | undefined,
  error: string | null,
  intent: string | null,
  undo?: AgentUndo | null,
) {
  await tx.insert(schema.agentActions).values({
    workspaceId: sql`nullif(current_setting('app.workspace_id', true), '')::uuid`,
    agentId,
    command: cmd.name,
    actionClass: policy.actionClass,
    decision: policy.decision,
    reasons: policy.reasons,
    impact: policy.impact as Record<string, unknown>,
    ok: error === null,
    error: error?.slice(0, 1000) ?? null,
    target: target ?? null,
    surface,
    mandateId: policy.mandate?.id ?? policy.shadow?.mandateId ?? null,
    mandateVersion: policy.mandate?.version ?? policy.shadow?.mandateVersion ?? null,
    shadow: policy.shadow ?? null,
    level: policy.level ?? null,
    intent: intent?.slice(0, 2000) ?? null,
    undo: undo ?? null,
  });
}

/**
 * Runs the mandate's independent check before an autonomous or held action. A mismatch, a missing
 * check (no AI provider) or an error sends the action to a person: the check fails closed.
 */
async function withIndependentCheck(
  tx: Tx,
  services: Services,
  policy: PolicyOutcome,
  req: { principal: Principal; command: string; input: unknown; intent: string | null; mandate: MandateView; approvable: boolean },
): Promise<PolicyOutcome> {
  let verdict: { ok: boolean; reason: string };
  if (!services.independentCheck)
    verdict = { ok: false, reason: 'The mandate asks for an independent check, but no AI provider is set up.' };
  else
    verdict = await services
      .independentCheck(tx, { ...req, policy })
      .catch((err: Error) => ({ ok: false, reason: `The independent check failed: ${err.message}` }));
  if (verdict.ok) return { ...policy, reasons: [...policy.reasons, `Independent check: ${verdict.reason}`] };
  const reasons = [...policy.reasons, `Independent check: ${verdict.reason}`];
  return req.approvable
    ? { ...policy, decision: 'ask', level: 1, autonomous: false, reasons }
    : { ...policy, decision: 'deny', level: 1, autonomous: false, reasons: [...reasons, `${req.command} cannot wait for an approval.`] };
}

/** What the agent said it is doing: an explicit intent, else the reviewer note or reason most commands take. */
function intentOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const key of ['intent', 'note', 'reason']) if (typeof i[key] === 'string' && i[key]) return i[key] as string;
  return null;
}

/**
 * What an agent did in the last 24 hours: changes it made, messages it sent directly and sends it
 * ran (#267). A change counts when it ran (`allow`, including a held change once it ran) or while
 * it is held and still due to run; a vetoed or reassigned hold does not. `excludeId` leaves out
 * the held action being decided again when its window ends.
 */
export async function agentCounters(tx: Tx, agentId: string, opts: { excludeId?: number } = {}): Promise<AgentCounters> {
  const a = schema.agentActions;
  const pendingHold = sql`(${a.decision} = 'hold' AND EXISTS (
    SELECT 1 FROM approval_requests ar
    WHERE ar.status = 'pending' AND ar.hold_until IS NOT NULL
      AND ar.artifact_id = ANY(string_to_array(${a.target}, ','))))`;
  // A held change's recheck entry (artifacts.heldRecheck, #282) only announces; the hold itself counts.
  const counted = sql`(${a.decision} = 'allow' OR ${pendingHold}) AND ${a.command} <> 'artifacts.heldRecheck'`;
  const excluded = opts.excludeId !== undefined ? sql`${a.id} <> ${opts.excludeId}` : undefined;
  // The previous send is the last one that ran: a vetoed send must not raise the growth baseline.
  // Stopping a send shares its class (#468) but is not a send for the counters.
  const isSend = sql`(${a.actionClass} = 'send.broadcast' AND ${a.command} <> 'broadcasts.cancel')`;
  const [prev] = await tx
    .select({ people: sql<number | null>`(${a.impact}->>'people')::int` })
    .from(a)
    .where(and(eq(a.agentId, agentId), isSend, eq(a.decision, 'allow'), eq(a.ok, true)))
    .orderBy(desc(a.id))
    .limit(1);
  const [row] = await tx
    .select({
      changes: sql<number>`count(*) FILTER (WHERE ${a.actionClass} <> 'draft')::int`,
      messages: sql<number>`coalesce(sum((${a.impact}->>'people')::int) FILTER (WHERE ${a.actionClass} = 'send.direct'), 0)::int`,
      sends: sql<number>`count(*) FILTER (WHERE ${isSend})::int`,
    })
    .from(a)
    .where(and(eq(a.agentId, agentId), counted, eq(a.ok, true), sql`${a.at} > now() - interval '24 hours'`, excluded));
  return { changes: row?.changes ?? 0, messages: row?.messages ?? 0, sends: row?.sends ?? 0, previousSendPeople: prev?.people ?? null };
}

/**
 * A read runs in a repeatable-read snapshot. The few writes a read can make (a workspace's data
 * key, created on first use) fail with a serialization error when another transaction wrote the
 * same row after the snapshot began, and the snapshot cannot see the winner. Run the read again
 * in a fresh snapshot, which does: twice at most.
 */
async function retrySnapshotConflicts<T>(isRead: boolean, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isRead || attempt >= 2 || !isSerializationFailure(err)) throw err;
    }
  }
}

/** Postgres SQLSTATE 40001, directly or as the cause of a Drizzle query error. */
export function isSerializationFailure(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++)
    if (e.code === '40001') return true;
  return false;
}
