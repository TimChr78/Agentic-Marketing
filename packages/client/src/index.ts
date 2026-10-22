import type { AnyCommand } from '@agentic-marketing/commands';
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

export function createClient<Cmds extends readonly AnyCommand[]>(opts: ClientOptions = {}) {
  const f = opts.fetch ?? fetch;
  return {
    async call<N extends Cmds[number]['name']>(
      name: N,
      input: CommandInput<Cmds, N>,
      callOpts: { idempotencyKey?: string } = {},
    ): Promise<CommandOutput<Cmds, N>> {
      const res = await f(`${opts.baseUrl ?? ''}/v1/${name}`, {
        method: 'POST',
        credentials: opts.credentials,
        headers: {
          'content-type': 'application/json',
          ...opts.headers,
          ...(callOpts.idempotencyKey ? { 'idempotency-key': callOpts.idempotencyKey } : {}),
        },
        body: JSON.stringify(input ?? {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText, body.details);
      return body as CommandOutput<Cmds, N>;
    },
  };
}
