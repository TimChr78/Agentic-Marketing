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
type WorkspaceListener = (id: string | null) => void;
const workspaceListeners = new Set<WorkspaceListener>();

/**
 * Chooses the workspace every call acts in. `persist: false` is the demo's in-memory switch: it
 * must never overwrite the workspace a signed-in person has stored for the real app (#524).
 */
export function setWorkspaceId(id: string | null, opts: { persist?: boolean } = {}) {
  workspaceId = id;
  if (opts.persist !== false) {
    if (id) localStorage.setItem('am.workspace', id);
    else localStorage.removeItem('am.workspace');
  }
  for (const listener of workspaceListeners) listener(id);
}
export const getWorkspaceId = () => workspaceId;

/** Notifies keyed caches (the shared picker index) when the chosen workspace changes. */
export function onWorkspaceChange(listener: WorkspaceListener): () => void {
  workspaceListeners.add(listener);
  return () => {
    workspaceListeners.delete(listener);
  };
}

const fetchWithWorkspace: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (workspaceId) headers.set('x-workspace-id', workspaceId);
  return fetch(input, { ...init, headers });
};

const base = createClient<Commands>({ credentials: 'include', fetch: fetchWithWorkspace });

/**
 * A command transport (#524). The demo installs a fixture-backed one; production leaves it unset
 * and every call goes through the real typed client. A transport receives the same command names
 * and inputs as the server, so a page never learns that it is in demo mode.
 */
export type CommandTransport = <N extends Commands[number]['name']>(
  name: N,
  input: CommandInput<Commands, N>,
  callOpts?: { idempotencyKey?: string },
) => Promise<CommandOutput<Commands, N>>;

let commandTransport: CommandTransport | null = null;

/**
 * Installs a transport (`null` restores the real API) and returns an uninstall that restores the
 * previous one. Only the demo entry and tests call this; no page branches on demo mode.
 */
export function setCommandTransport(transport: CommandTransport | null): () => void {
  const previous = commandTransport;
  commandTransport = transport;
  return () => {
    if (commandTransport === transport) commandTransport = previous;
  };
}

export const api = {
  async call<N extends Commands[number]['name']>(
    name: N,
    input: CommandInput<Commands, N>,
    callOpts: { idempotencyKey?: string } = {},
  ): Promise<CommandOutput<Commands, N>> {
    const out = commandTransport
      ? await (
          commandTransport as unknown as (
            n: N,
            i: CommandInput<Commands, N>,
            o?: { idempotencyKey?: string },
          ) => Promise<CommandOutput<Commands, N>>
        )(name, input, callOpts)
      : ((await base.call(name, input, callOpts)) as CommandOutput<Commands, N>);
    readListener?.(name, input, out);
    return out as CommandOutput<Commands, N>;
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
