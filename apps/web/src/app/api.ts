import { ApiError, type CommandInput, type CommandOutput, createClient } from '@agentic-marketing/client';
import type { Commands } from '@agentic-marketing/server/src/registry';

type ReadListener = (name: string, input: unknown, output: unknown) => void;
let readListener: ReadListener | null = null;

/**
 * Lets the admin UI observe successful reads (used by recents). It runs after the response is
 * already a success, so a failed or forbidden read is never reported.
 */
export function setReadListener(listener: ReadListener | null) {
  readListener = listener;
}

// The real API through the typed client. Every call is the same command an MCP agent would make,
// under the same rules. The chosen workspace goes in X-Workspace-Id on every call.

let workspaceId: string | null = localStorage.getItem('am.workspace');
export function setWorkspaceId(id: string | null) {
  workspaceId = id;
  if (id) localStorage.setItem('am.workspace', id);
  else localStorage.removeItem('am.workspace');
}
export const getWorkspaceId = () => workspaceId;

const fetchWithWorkspace: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (workspaceId) headers.set('x-workspace-id', workspaceId);
  return fetch(input, { ...init, headers });
};

const base = createClient<Commands>({ credentials: 'include', fetch: fetchWithWorkspace });

export const api = {
  async call<N extends Commands[number]['name']>(
    name: N,
    input: CommandInput<Commands, N>,
    callOpts: { idempotencyKey?: string } = {},
  ): Promise<CommandOutput<Commands, N>> {
    const out = (await base.call(name, input, callOpts)) as CommandOutput<Commands, N>;
    readListener?.(name, input, out);
    return out;
  },
};

/**
 * A client that acts in one chosen brand for a single call, without switching the shell. Used when
 * creating a token for another brand (#187); the server still checks the person's role there.
 */
export function apiForWorkspace(id: string) {
  const fetchForWorkspace: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-workspace-id', id);
    return fetch(input, { ...init, headers });
  };
  return createClient<Commands>({ credentials: 'include', fetch: fetchForWorkspace });
}
export type CommandName = Commands[number]['name'];
export type Out<N extends CommandName> = CommandOutput<Commands, N>;
export type In<N extends CommandName> = CommandInput<Commands, N>;
export { ApiError };

/** The message to show for a failed call: the server's own reason. */
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
export const errDetails = (e: unknown) => (e instanceof ApiError ? e.details : undefined);
