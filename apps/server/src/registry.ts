import { artifactCommands, workspaceCommands } from '@agentic-marketing/artifacts';
import { memberCommands } from '@agentic-marketing/auth';
import type { AnyCommand } from '@agentic-marketing/commands';
import { sourceCommands } from '@agentic-marketing/ingest';
import { profileCommands } from '@agentic-marketing/profiles';
import { secretCommands } from '@agentic-marketing/secrets';

/** Every command the server exposes. REST routes, OpenAPI, MCP tools and the UI client derive from this list. */
export const commands = [
  ...artifactCommands,
  ...workspaceCommands,
  ...memberCommands,
  ...sourceCommands,
  ...profileCommands,
  ...secretCommands,
] as const;
export type Commands = typeof commands;

export const commandByName = new Map<string, AnyCommand>(commands.map((c) => [c.name, c]));
