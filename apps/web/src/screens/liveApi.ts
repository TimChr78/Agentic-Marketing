import { ApiError, type CommandOutput, createClient } from '@agentic-marketing/client';
import type { Commands } from '@agentic-marketing/server/src/registry';

// The real API (apps/server) through the typed client. Every call is the same command an MCP
// agent would make, under the same rules.

export const api = createClient<Commands>({ credentials: 'include' });
export type Out<N extends Commands[number]['name']> = CommandOutput<Commands, N>;
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);
