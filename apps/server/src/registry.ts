import { adAudienceCommands, adCommands, spendCommands } from '@agentic-marketing/ads';
import { aiCommands } from '@agentic-marketing/ai';
import { artifactCommands, configCommands, workspaceCommands } from '@agentic-marketing/artifacts';
import { audienceCommands } from '@agentic-marketing/audience';
import { listSsoProviders, memberCommands, scimCommands, tokenCommands } from '@agentic-marketing/auth';
import type { AnyCommand } from '@agentic-marketing/commands';
import {
  deliverabilityCommands,
  messageCommands,
  providerCommands,
  pushCommands,
  pushProviderCommands,
  smsCommands,
  smsProviderCommands,
  templateCommands,
} from '@agentic-marketing/email';
import { sourceCommands } from '@agentic-marketing/ingest';
import { connectionCommands, oauthCommands, webhookCommands } from '@agentic-marketing/integrations';
import { journeyCommands } from '@agentic-marketing/journeys';
import { edgeCommands, experienceCommands } from '@agentic-marketing/personalize';
import { profileCommands } from '@agentic-marketing/profiles';
import { secretCommands } from '@agentic-marketing/secrets';
import { segmentCommands } from '@agentic-marketing/segments';
import { warehouseCommands } from '@agentic-marketing/warehouse';

/** Every command the server exposes. REST routes, OpenAPI, MCP tools and the UI client derive from this list. */
export const commands = [
  ...artifactCommands,
  ...configCommands,
  ...warehouseCommands,
  ...templateCommands,
  ...messageCommands,
  ...providerCommands,
  ...deliverabilityCommands,
  ...smsCommands,
  ...smsProviderCommands,
  ...pushCommands,
  ...pushProviderCommands,
  ...workspaceCommands,
  ...memberCommands,
  ...scimCommands,
  listSsoProviders,
  ...tokenCommands,
  ...sourceCommands,
  ...profileCommands,
  ...segmentCommands,
  ...journeyCommands,
  ...experienceCommands,
  ...edgeCommands,
  ...aiCommands,
  ...audienceCommands,
  ...connectionCommands,
  ...adCommands,
  ...adAudienceCommands,
  ...spendCommands,
  ...oauthCommands,
  ...webhookCommands,
  ...secretCommands,
] as const;
export type Commands = typeof commands;

export const commandByName = new Map<string, AnyCommand>(commands.map((c) => [c.name, c]));
