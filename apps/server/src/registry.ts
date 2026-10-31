import { adAudienceCommands, adCommands, spendCommands } from '@agentic-marketing/ads';
import { aiCommands } from '@agentic-marketing/ai';
import { alertsCommands } from '@agentic-marketing/alerts';
import { analyticsCommands } from '@agentic-marketing/analytics';
import { artifactCommands, configCommands, contentTopicCommands, learningsCommands, workspaceCommands } from '@agentic-marketing/artifacts';
import { assetCommands } from '@agentic-marketing/assets';
import { audienceCommands } from '@agentic-marketing/audience';
import {
  agentCommands,
  agentEventCommands,
  hostedAgentCommands,
  listSsoProviders,
  memberCommands,
  scimCommands,
  tokenCommands,
} from '@agentic-marketing/auth';
import { campaignCommands } from '@agentic-marketing/campaigns';
import type { AnyCommand } from '@agentic-marketing/commands';
import {
  blockCommands,
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
import { connectionCommands, importShopifyCustomers, oauthCommands, webhookCommands } from '@agentic-marketing/integrations';
import { journeyCommands } from '@agentic-marketing/journeys';
import { edgeCommands, experienceCommands } from '@agentic-marketing/personalize';
import { profileCommands } from '@agentic-marketing/profiles';
import { secretCommands } from '@agentic-marketing/secrets';
import { segmentCommands } from '@agentic-marketing/segments';
import { warehouseCommands } from '@agentic-marketing/warehouse';

/** Every command the server exposes. REST routes, OpenAPI, MCP tools and the UI client derive from this list. */
export const commands = [
  ...artifactCommands,
  ...contentTopicCommands,
  ...learningsCommands,
  ...assetCommands,
  ...configCommands,
  ...warehouseCommands,
  ...templateCommands,
  ...blockCommands,
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
  ...agentCommands,
  ...agentEventCommands,
  ...hostedAgentCommands,
  ...sourceCommands,
  ...profileCommands,
  ...segmentCommands,
  ...journeyCommands,
  ...experienceCommands,
  ...edgeCommands,
  ...aiCommands,
  ...analyticsCommands,
  ...alertsCommands,
  ...audienceCommands,
  ...campaignCommands,
  ...connectionCommands,
  importShopifyCustomers,
  ...adCommands,
  ...adAudienceCommands,
  ...spendCommands,
  ...oauthCommands,
  ...webhookCommands,
  ...secretCommands,
] as const;
export type Commands = typeof commands;

export const commandByName = new Map<string, AnyCommand>(commands.map((c) => [c.name, c]));
