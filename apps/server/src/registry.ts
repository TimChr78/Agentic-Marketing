import { aiCommands } from '@agentic-marketing/ai';
import { artifactCommands, workspaceCommands } from '@agentic-marketing/artifacts';
import { memberCommands, tokenCommands } from '@agentic-marketing/auth';
import type { AnyCommand } from '@agentic-marketing/commands';
import { messageCommands, providerCommands, templateCommands } from '@agentic-marketing/email';
import { sourceCommands } from '@agentic-marketing/ingest';
import { connectionCommands, webhookCommands } from '@agentic-marketing/integrations';
import { journeyCommands } from '@agentic-marketing/journeys';
import { experienceCommands } from '@agentic-marketing/personalize';
import { profileCommands } from '@agentic-marketing/profiles';
import { secretCommands } from '@agentic-marketing/secrets';
import { segmentCommands } from '@agentic-marketing/segments';

/** Every command the server exposes. REST routes, OpenAPI, MCP tools and the UI client derive from this list. */
export const commands = [
  ...artifactCommands,
  ...templateCommands,
  ...messageCommands,
  ...providerCommands,
  ...workspaceCommands,
  ...memberCommands,
  ...tokenCommands,
  ...sourceCommands,
  ...profileCommands,
  ...segmentCommands,
  ...journeyCommands,
  ...experienceCommands,
  ...aiCommands,
  ...connectionCommands,
  ...webhookCommands,
  ...secretCommands,
] as const;
export type Commands = typeof commands;

export const commandByName = new Map<string, AnyCommand>(commands.map((c) => [c.name, c]));
