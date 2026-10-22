import { AppError, canonicalJson, hashValue, sha256 } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Permission, Principal } from './principal';

// The command registry (ADR-0005): every capability is a command. REST, MCP and the typed UI
// client are generated from these definitions, and `execute` is the only way to run one, so
// validation, authorization, idempotency and audit cannot be skipped by any surface.

export type Effect = 'read' | 'write' | 'publish' | 'destructive';
export type Surface = 'rest' | 'mcp' | 'internal';

/** Extension point for dependencies commands need (key providers, clocks…). Packages augment it. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by other packages via declaration merging
export interface Services {}

export interface CommandContext {
  principal: Principal;
  tx: Tx;
  services: Services;
  /** Runs `fn` once the command's transaction has committed (e.g. to invalidate caches); errors are logged, not thrown. */
  afterCommit?: (fn: () => Promise<void>) => void;
}

export interface CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, N extends string = string> {
  name: N;
  title: string;
  description: string;
  input: I;
  output: O;
  /** null only for internal commands that are not in the public registry (e.g. accepting an invitation). */
  permission: Permission | null;
  effect: Effect;
  /** Agents may never run it, whatever their scopes (approving, managing members…). */
  humansOnly?: boolean;
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

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous command lists
export type AnyCommand = CommandDef<any, any, string>;

export interface ExecuteOptions {
  surface: Surface;
  idempotencyKey?: string;
}

const tracer = trace.getTracer('@agentic-marketing/commands');

function redact(input: unknown, fields?: readonly string[]) {
  if (!fields?.length || !input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fields.includes(k) ? '[redacted]' : v]));
}

export function createExecutor(db: Db, services: Services) {
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

      const fail = async (err: AppError): Promise<never> => {
        // The main transaction rolled back; record the failed attempt in its own.
        await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target, err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.code });
        span.end();
        throw err;
      };

      const parsed = cmd.input.safeParse(input);
      if (!parsed.success)
        return fail(new AppError('invalid_input', 'The input does not match the command schema.', z.treeifyError(parsed.error)));
      target = cmd.target?.(parsed.data);
      if (cmd.humansOnly && principal.type !== 'user')
        return fail(new AppError('forbidden', `${cmd.name} can only be run by a person, not by an agent.`));
      if (cmd.permission && !principal.permissions.has(cmd.permission))
        return fail(
          new AppError(
            'forbidden',
            principal.type === 'agent'
              ? `This agent was not granted the "${cmd.permission}" permission. The person can grant it when connecting the agent.`
              : `Your role (${principal.role}) does not include the "${cmd.permission}" permission.`,
          ),
        );

      const committed: (() => Promise<void>)[] = [];
      try {
        const result = await db.withWorkspace(
          principal.workspaceId,
          async (tx) => {
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
            const out = cmd.output.parse(
              await cmd.handler(parsed.data, { principal, tx, services, afterCommit: (fn) => committed.push(fn) }),
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
            return out;
          },
          // Reads see one consistent snapshot; writes keep read-committed so their locks see the latest rows.
          { snapshot: cmd.effect === 'read' },
        );
        // An audited read is recorded in its own transaction: the hash chain must be appended under
        // its lock with the latest entries visible, which a snapshot taken earlier would not show.
        if (cmd.effect === 'read' && cmd.auditReads)
          await db.withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, target));
        for (const fn of committed) await fn().catch((err) => span.recordException(err as Error));
        span.end();
        return result;
      } catch (err) {
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
