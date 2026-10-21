import type { z } from 'zod';
import type { CommandByName, CommandName } from '../commands';

// Typed UI client: input and output types come straight from the registry's zod schemas.
// Nothing is generated on disk; a renamed field or command is a compile error in the UI.

export type CommandInput<N extends CommandName> = z.input<CommandByName<N>['input']>;
export type CommandOutput<N extends CommandName> = z.output<CommandByName<N>['output']>;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function createClient(baseUrl: string, init: { fetch?: typeof fetch; headers?: Record<string, string> } = {}) {
  const f = init.fetch ?? fetch;
  return {
    async call<N extends CommandName>(name: N, input: CommandInput<N>, opts: { idempotencyKey?: string } = {}): Promise<CommandOutput<N>> {
      const res = await f(`${baseUrl}/v1/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...init.headers,
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) throw new ApiError(res.status, body.error, body.message, body.details);
      return body as CommandOutput<N>;
    },
  };
}
