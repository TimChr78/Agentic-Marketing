import { ApiError, type CommandInput, type CommandOutput, createClient } from '@agentic-marketing/client';
import type { Commands } from '@agentic-marketing/server/src/registry';

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

export const api = createClient<Commands>({ credentials: 'include', fetch: fetchWithWorkspace });
export type CommandName = Commands[number]['name'];
export type Out<N extends CommandName> = CommandOutput<Commands, N>;
export type In<N extends CommandName> = CommandInput<Commands, N>;
export { ApiError };

/** The message to show for a failed call: the server's own reason. */
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
export const errDetails = (e: unknown) => (e instanceof ApiError ? e.details : undefined);
