import { approve, createDraft, getJourney, listAudit, listJourneys, requestPublish, updateDraft } from './journeys';

/** The full registry. `as const` keeps each command's name and schemas for the typed client. */
export const commands = [createDraft, updateDraft, getJourney, listJourneys, requestPublish, approve, listAudit] as const;

export type Commands = typeof commands;
export type CommandName = Commands[number]['name'];
export type CommandByName<N extends CommandName> = Extract<Commands[number], { name: N }>;

export const commandByName = new Map<string, Commands[number]>(commands.map((c) => [c.name, c]));

/** Role → permissions. OAuth scopes use the same strings, so an agent gets role ∩ granted scopes. */
export const rolePermissions: Record<string, string[]> = {
  owner: ['journeys:read', 'journeys:write', 'journeys:publish', 'audit:read'],
  marketer: ['journeys:read', 'journeys:write', 'journeys:publish'],
  viewer: ['journeys:read'],
};

export const allScopes = [...new Set(commands.map((c) => c.permission))];
