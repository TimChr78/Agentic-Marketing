import type { AnyCommand } from '@agentic-marketing/commands';
// The validator module only: the core index also pulls Node-only hashing and net helpers, which a
// browser bundle must not load.
import { IDEMPOTENCY_KEY_MAX, isValidIdempotencyKey } from '@agentic-marketing/core/idempotency';
import type { z } from 'zod';

// Typed client for the REST surface. Input and output types are inferred from the command
// definitions, so the UI breaks at compile time when a command changes. No code generation.

type ByName<Cmds extends readonly AnyCommand[], N extends Cmds[number]['name']> = Extract<Cmds[number], { name: N }>;
export type CommandInput<Cmds extends readonly AnyCommand[], N extends Cmds[number]['name']> = z.input<ByName<Cmds, N>['input']>;
export type CommandOutput<Cmds extends readonly AnyCommand[], N extends Cmds[number]['name']> = z.output<ByName<Cmds, N>['output']>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  /** Base URL of the API; '' for same-origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** 'include' for cookie sessions across origins. */
  credentials?: RequestCredentials;
}

export interface CallOptions {
  /** Reuse one key across retries of one logical call; a fresh one per attempt would run it twice. */
  idempotencyKey?: string;
}

/** The machine-readable sub-code of a 409, e.g. `idempotency_in_progress` (#906). */
export function conflictReason(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const details = err.details;
  if (!details || typeof details !== 'object' || !('reason' in details)) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** A 409 saying the winner is still running: retrying with the same key is the contract. */
export function isIdempotencyInProgress(err: unknown): boolean {
  return conflictReason(err) === 'idempotency_in_progress';
}

/**
 * Delays between attempts of {@link createClient}'s `callWithRetry`, measured from the end of the
 * failed attempt. Five attempts in total and about 12 s of waiting, well under a minute.
 */
const RETRY_DELAYS_MS = [250, 1_000, 3_000, 8_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const newIdempotencyKey = () => globalThis.crypto.randomUUID();

/** Refuses a supplied key before any request, with the server's own rule (#906 review round 2). */
function checkIdempotencyKey(key: string | undefined): void {
  if (key !== undefined && !isValidIdempotencyKey(key))
    throw new Error(`An idempotency key must be 1 to ${IDEMPOTENCY_KEY_MAX} printable characters without spaces.`);
}

export interface Client<Cmds extends readonly AnyCommand[]> {
  /** One attempt. A retry must pass the same `idempotencyKey`; see `callWithRetry`. */
  call<N extends Cmds[number]['name']>(name: N, input: CommandInput<Cmds, N>, callOpts?: CallOptions): Promise<CommandOutput<Cmds, N>>;
}

export function createClient<Cmds extends readonly AnyCommand[]>(opts: ClientOptions = {}): Client<Cmds> {
  const f = opts.fetch ?? fetch;

  async function once<N extends Cmds[number]['name']>(
    name: N,
    input: CommandInput<Cmds, N>,
    callOpts: CallOptions,
  ): Promise<CommandOutput<Cmds, N>> {
    const res = await f(`${opts.baseUrl ?? ''}/v1/${name}`, {
      method: 'POST',
      credentials: opts.credentials,
      headers: {
        'content-type': 'application/json',
        ...opts.headers,
        // Presence, not truthiness: an empty key was validated away, and a key of "0" is valid.
        ...(callOpts.idempotencyKey !== undefined ? { 'idempotency-key': callOpts.idempotencyKey } : {}),
      },
      body: JSON.stringify(input ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText, body.details);
    return body as CommandOutput<Cmds, N>;
  }

  return {
    call<N extends Cmds[number]['name']>(
      name: N,
      input: CommandInput<Cmds, N>,
      callOpts: CallOptions = {},
    ): Promise<CommandOutput<Cmds, N>> {
      checkIdempotencyKey(callOpts.idempotencyKey);
      return once(name, input, callOpts);
    },
  };
}

/**
 * A logical call with safe retries (#906). It mints one idempotency key (or uses the one you pass)
 * and keeps it across every attempt, so a retry after a lost answer replays the first result
 * instead of running the command again.
 *
 * It retries a network failure and the `409 conflict` that says the first request is still in
 * progress, with bounded backoff. It never retries the other conflict ("already used for a
 * different request") or any other 4xx: those are answers, not races.
 *
 * A free function, not a client method, so a browser app that only calls `call` does not carry the
 * retry loop in its bundle.
 */
export async function callWithRetry<Cmds extends readonly AnyCommand[], N extends Cmds[number]['name']>(
  client: Client<Cmds>,
  name: N,
  input: CommandInput<Cmds, N>,
  callOpts: CallOptions = {},
): Promise<CommandOutput<Cmds, N>> {
  checkIdempotencyKey(callOpts.idempotencyKey);
  const idempotencyKey = callOpts.idempotencyKey ?? newIdempotencyKey();
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.call(name, input, { idempotencyKey });
    } catch (err) {
      const retryable = err instanceof ApiError ? isIdempotencyInProgress(err) : true;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}
