import { createHash } from 'node:crypto';
import { desc, and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withWorkspace, type Tx } from './db/pool';
import { auditLog, idempotencyKeys } from './db/schema';

// The command registry (ADR-0005): every capability is defined once and the REST API,
// the MCP server and the typed UI client are all derived from these definitions.
// Cross-cutting rules (validation, authorization, idempotency, audit) live in
// `execute`, so no surface can skip them.

export type Effect = 'read' | 'write' | 'publish' | 'destructive';
export type Surface = 'rest' | 'mcp' | 'internal';

export interface Principal {
  type: 'user' | 'agent';
  /** User id; for agents, the user the agent acts on behalf of. */
  userId: string;
  /** OAuth client id for agents. */
  clientId?: string;
  workspaceId: string;
  /** Effective permissions: role permissions ∩ token scopes. */
  scopes: Set<string>;
}

export interface CommandContext {
  principal: Principal;
  tx: Tx;
}

export interface CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, N extends string = string> {
  name: N;
  title: string;
  description: string;
  input: I;
  output: O;
  /** Permission (and OAuth scope) required to run the command. */
  permission: string;
  effect: Effect;
  /** Agents may never run it, whatever their scopes (e.g. approving changes). */
  humansOnly?: boolean;
  handler: (input: z.output<I>, ctx: CommandContext) => Promise<z.input<O>>;
}

export function defineCommand<N extends string, I extends z.ZodType, O extends z.ZodType>(def: CommandDef<I, O, N>) {
  return def;
}

export class CommandError extends Error {
  constructor(
    public code: 'invalid_input' | 'forbidden' | 'not_found' | 'conflict',
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const httpStatus: Record<CommandError['code'], number> = { invalid_input: 400, forbidden: 403, not_found: 404, conflict: 409 };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Stable JSON so the same input always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

async function appendAudit(
  tx: Tx,
  p: Principal,
  surface: Surface,
  cmd: CommandDef,
  inputHash: string,
  ok: boolean,
  error?: string,
) {
  // Hash chain per workspace: each entry commits to the previous one, so edits are detectable.
  // (A production version needs a per-workspace lock or sequence to avoid forks under concurrency.)
  const [prev] = await tx.select({ hash: auditLog.hash }).from(auditLog).where(eq(auditLog.workspaceId, p.workspaceId)).orderBy(desc(auditLog.seq)).limit(1);
  const entry = {
    workspaceId: p.workspaceId,
    principalType: p.type,
    principalId: p.userId,
    clientId: p.clientId ?? null,
    surface,
    command: cmd.name,
    effect: cmd.effect,
    inputHash,
    ok,
    error: error ?? null,
    prevHash: prev?.hash ?? null,
  };
  await tx.insert(auditLog).values({ ...entry, hash: sha256(canonical(entry)) });
}

export interface ExecuteOptions {
  surface: Surface;
  idempotencyKey?: string;
}

/** Run one command for one principal: validate → authorize → idempotency → handler → audit. */
export async function execute<C extends CommandDef>(cmd: C, rawInput: unknown, principal: Principal, opts: ExecuteOptions): Promise<z.output<C['output']>> {
  const parsed = cmd.input.safeParse(rawInput ?? {});
  const inputHash = sha256(canonical(rawInput ?? {}));

  const fail = async (err: CommandError) => {
    // Failed attempts are audited too, in their own transaction (the main one rolled back).
    await withWorkspace(principal.workspaceId, (tx) => appendAudit(tx, principal, opts.surface, cmd, inputHash, false, `${err.code}: ${err.message}`));
    throw err;
  };

  if (!parsed.success) return fail(new CommandError('invalid_input', 'Input does not match the schema', z.treeifyError(parsed.error)));
  if (cmd.humansOnly && principal.type !== 'user') return fail(new CommandError('forbidden', `${cmd.name} can only be run by a person, not by an agent`));
  if (!principal.scopes.has(cmd.permission)) return fail(new CommandError('forbidden', `Missing permission ${cmd.permission}`));

  try {
    return await withWorkspace(principal.workspaceId, async (tx) => {
      if (opts.idempotencyKey) {
        const [hit] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.workspaceId, principal.workspaceId), eq(idempotencyKeys.key, opts.idempotencyKey)));
        if (hit) {
          if (hit.command !== cmd.name || hit.inputHash !== inputHash) throw new CommandError('conflict', 'Idempotency key was already used for a different request');
          return hit.response as z.output<C['output']>;
        }
      }
      const result = cmd.output.parse(await cmd.handler(parsed.data, { principal, tx }));
      if (opts.idempotencyKey)
        await tx.insert(idempotencyKeys).values({ workspaceId: principal.workspaceId, key: opts.idempotencyKey, command: cmd.name, inputHash, response: result });
      await appendAudit(tx, principal, opts.surface, cmd, inputHash, true);
      return result as z.output<C['output']>;
    });
  } catch (err) {
    if (err instanceof CommandError) return fail(err);
    throw err;
  }
}
