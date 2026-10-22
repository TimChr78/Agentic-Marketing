import { adCommands } from '@agentic-marketing/ads';
import { aiCommands } from '@agentic-marketing/ai';
import { artifactCommands, workspaceCommands } from '@agentic-marketing/artifacts';
import { audienceCommands } from '@agentic-marketing/audience';
import { memberCommands, tokenCommands } from '@agentic-marketing/auth';
import type { AnyCommand } from '@agentic-marketing/commands';
import {
  deliverabilityCommands,
  messageCommands,
  providerCommands,
  smsCommands,
  smsProviderCommands,
  templateCommands,
} from '@agentic-marketing/email';
import { sourceCommands } from '@agentic-marketing/ingest';
import { connectionCommands, oauthCommands, webhookCommands } from '@agentic-marketing/integrations';
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
  ...deliverabilityCommands,
  ...smsCommands,
  ...smsProviderCommands,
  ...workspaceCommands,
  ...memberCommands,
  ...tokenCommands,
  ...sourceCommands,
  ...profileCommands,
  ...segmentCommands,
  ...journeyCommands,
  ...experienceCommands,
  ...aiCommands,
  ...audienceCommands,
  ...connectionCommands,
  ...adCommands,
  ...oauthCommands,
  ...webhookCommands,
  ...secretCommands,
] as const;
export type Commands = typeof commands;

export const commandByName = new Map<string, AnyCommand>(commands.map((c) => [c.name, c]));
