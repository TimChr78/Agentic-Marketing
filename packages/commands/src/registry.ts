import { AppError, canonicalJson, hashValue, sha256 } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type ActionClass,
  type AgentCounters,
  autonomySettings,
  decide,
  type Impact,
  type MandateView,
  type PolicyOutcome,
  REACH_CLASSES,
} from './policy';
import type { Permission, Principal } from './principal';
import { findUnknownInputKeys, type UnknownInputKey, unknownKeyMessages } from './unknownKeys';

// The command registry (ADR-0005): every capability is a command. REST, MCP and the typed UI
// client are generated from these definitions, and `execute` is the only way to run one, so
// validation, authorization, idempotency and audit cannot be skipped by any surface.

export type Effect = 'read' | 'write' | 'publish' | 'destructive';
export type Surface = 'rest' | 'mcp' | 'scim' | 'internal';

/** Extension point for dependencies commands need (key providers, clocks…). Packages augment it. */
export interface Services {
  /** Public URL of the server, e.g. for admin UI deep links in command output. */
  publicUrl?: string;
  /** Links host (PUBLIC_LINKS_URL), for shareable unsubscribe, form, web-version and archive URLs. */
  linksUrl?: string;
  /** Version of the running server, so command output can show it (workspace.get). */
  serverVersion: string;
  /** Whether unknown input keys are rejected rather than warned about (STRICT_INPUTS). */
  strictInputs: boolean;
  /** Shared counter for wrong passwords on token widening (#61), so every process sees the lockout. */
  stepUpLimiter?: StepUpLimiter;
  /** The agent's active mandate (ADR-0016); registered by packages/artifacts through the server. */
  activeMandate?: (tx: Tx, agentId: string) => Promise<{ view: MandateView; outsideHours: string | null } | null>;
  /** Why an agent's recent sends breach its mandate's guardrails, or null; registered by the server (metric layer). */
  mandateGuardrails?: (tx: Tx, workspaceId: string, agentId: string, mandate: MandateView) => Promise<string | null>;
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
  /** Runs `fn` once the command's transaction has committed (e.g. to invalidate caches); errors are logged, not thrown. */
  afterCommit?: (fn: () => Promise<void>) => void;
  /** The policy engine's decision for an agent write (ADR-0016). "ask" means the change must wait for a person. */
  policy?: PolicyOutcome;
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
  /** What the command acts on, for the audit log (e.g. an artifact id). */
  target?: (input: z.output<I>) => string | undefined;
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

export function createExecutor(db: Db, services: Services, options: ExecutorOptions = {}) {
  async function appendAudit(
    tx: Tx,
    p: Principal,
    surface: Surface,
    cmd: AnyCommand,
    inputHash: string,
    target: string | undefined,
    error?: AppError,
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
    };
    await tx.insert(schema.auditLog).values({ ...entry, hash: sha256(canonicalJson(entry)) });
  }

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
      const unknown = findUnknownInputKeys(cmd.input, input);
      const unknownMessages = unknownKeyMessages(cmd.name, unknown);

      const fail = async (err: AppError): Promise<never> => {
        // The main transaction rolled back; record the failed attempt in its own.
        await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target, err));
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
              // ADR-0016: every agent write passes the policy engine before the handler runs.
              if (agent && cmd.effect !== 'read') {
                const base = { principal, tx, services };
                const impact = cmd.impact ? await cmd.impact(parsed.data, base) : {};
                const [ws] = await tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
                const actionClass = impact.actionClass ?? actionClassOf(cmd);
                const mandate = actionClass === 'read' ? null : ((await services.activeMandate?.(tx, agent.id)) ?? null);
                const guardrailBreach =
                  mandate && REACH_CLASSES.includes(actionClass) && services.mandateGuardrails
                    ? await services.mandateGuardrails(tx, principal.workspaceId, agent.id, mandate.view)
                    : null;
                policy = decide({
                  command: cmd.name,
                  actionClass,
                  impact,
                  settings: autonomySettings(ws?.autonomy),
                  counters: await agentCounters(tx, agent.id),
                  approvable: cmd.approvable === true,
                  ...(mandate ? { mandate: mandate.view, outsideHours: mandate.outsideHours, guardrailBreach } : {}),
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
              const out = withInputWarnings(
                cmd.output.parse(
                  await cmd.handler(parsed.data, { principal, tx, services, policy, afterCommit: (fn) => committed.push(fn) }),
                ),
                unknownMessages,
              ) as z.output<C['output']>;
              if (opts.idempotencyKey)
                await tx.insert(schema.idempotencyKeys).values({
                  workspaceId: principal.workspaceId,
                  key: opts.idempotencyKey,
                  command: cmd.name,
                  inputHash,
                  response: redact(out, cmd.sensitiveOutput) as object,
                });
              if (cmd.effect !== 'read') await appendAudit(tx, principal, opts.surface, cmd, inputHash, target);
              if (agent && policy) await recordAgentAction(tx, agent.id, cmd, policy, opts.surface, target, null, intentOf(parsed.data));
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

/** One agent write in the ledger (#218), with the decision that allowed, escalated or refused it. */
async function recordAgentAction(
  tx: Tx,
  agentId: string,
  cmd: AnyCommand,
  policy: PolicyOutcome,
  surface: Surface,
  target: string | undefined,
  error: string | null,
  intent: string | null,
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
    mandateId: policy.mandate?.id ?? null,
    mandateVersion: policy.mandate?.version ?? null,
    intent: intent?.slice(0, 2000) ?? null,
  });
}

/** What the agent said it is doing: an explicit intent, else the reviewer note or reason most commands take. */
function intentOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const key of ['intent', 'note', 'reason']) if (typeof i[key] === 'string' && i[key]) return i[key] as string;
  return null;
}

/** What an agent did in the last 24 hours: changes it made itself, and messages it sent directly. */
export async function agentCounters(tx: Tx, agentId: string): Promise<AgentCounters> {
  const [prev] = await tx
    .select({ people: sql<number | null>`(${schema.agentActions.impact}->>'people')::int` })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.agentId, agentId),
        eq(schema.agentActions.actionClass, 'send.broadcast'),
        sql`${schema.agentActions.decision} IN ('allow', 'hold')`,
        eq(schema.agentActions.ok, true),
      ),
    )
    .orderBy(desc(schema.agentActions.id))
    .limit(1);
  const [row] = await tx
    .select({
      changes: sql<number>`count(*) FILTER (WHERE ${schema.agentActions.actionClass} <> 'draft')::int`,
      messages: sql<number>`coalesce(sum((${schema.agentActions.impact}->>'people')::int) FILTER (WHERE ${schema.agentActions.actionClass} = 'send.direct'), 0)::int`,
      sends: sql<number>`count(*) FILTER (WHERE ${schema.agentActions.actionClass} = 'send.broadcast')::int`,
    })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.agentId, agentId),
        sql`${schema.agentActions.decision} IN ('allow', 'hold')`,
        eq(schema.agentActions.ok, true),
        sql`${schema.agentActions.at} > now() - interval '24 hours'`,
      ),
    );
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
