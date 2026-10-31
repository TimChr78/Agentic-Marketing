import type { Out } from '../../app/api';
import type { Tone } from '../../ui';

// Words for the agents UI (ADR-0016, #213/#215). Every state and decision reads as a sentence a
// person can act on: "Waited for a person", not "ask"; "Run the loop", not "4".

export type Agent = Out<'agents.list'>['agents'][number];
export type AgentStatus = Agent['status'];
export type AgentAction = Out<'agents.activity'>['actions'][number];
export type AgentDecision = AgentAction['decision'];
export type Autonomy = Out<'workspace.autonomy'>;
/** A hosted agent (#258); null from agents.hostedRuns for an agent the platform does not run. */
export type HostedAgentView = NonNullable<Out<'agents.hostedRuns'>['hosted']>;
export type HostedAgentRun = Out<'agents.hostedRuns'>['runs'][number];

/** The permissions the hosted agent editor offers, in the words people use. */
export const HOSTED_SCOPES = [
  { key: 'artifacts:read', label: 'Read artifacts and analytics' },
  { key: 'artifacts:write', label: 'Draft and edit artifacts' },
  { key: 'artifacts:publish', label: 'Submit changes for publishing' },
  { key: 'messages:send', label: 'Send messages' },
  { key: 'audit:read', label: 'Read the audit log' },
  { key: 'profiles:read', label: 'Read profiles' },
  { key: 'secrets:read', label: 'Use stored secrets' },
] as const;
export type HostedScope = (typeof HOSTED_SCOPES)[number]['key'];

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'good' },
  paused: { label: 'Paused', tone: 'warn' },
  revoked: { label: 'Revoked', tone: 'bad' },
};

/** The badge for one policy decision: allow ran, hold waited for a veto window, ask waited for a person, deny was refused. */
export const DECISION: Record<AgentDecision, { label: string; tone: Tone }> = {
  allow: { label: 'Allowed', tone: 'good' },
  hold: { label: 'Held for a veto', tone: 'warn' },
  ask: { label: 'Waited for a person', tone: 'warn' },
  deny: { label: 'Refused', tone: 'bad' },
};

export const decisionBadge = (decision: AgentDecision) => DECISION[decision];

export const CREDENTIAL_KIND: Record<Agent['credentials'][number]['kind'], string> = {
  api_token: 'API token',
  oauth_client: 'MCP client',
  hosted: 'Hosted run',
};

/** Kinds with counts: "1 API token, 2 MCP clients". Empty when the agent has no credential (unlikely). */
export function credentialKinds(agent: Agent): string {
  const counts = new Map<string, number>();
  for (const c of agent.credentials) {
    const label = CREDENTIAL_KIND[c.kind] ?? c.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label}${n === 1 ? '' : 's'}`).join(', ');
}

/** "2 credentials: 1 API token, 1 MCP client" in one line, for a table cell. */
export function credentialSummary(agent: Agent): string {
  const total = agent.credentials.length;
  const kinds = credentialKinds(agent);
  return `${total} credential${total === 1 ? '' : 's'}${kinds ? `: ${kinds}` : ''}`;
}

export const ACTION_CLASS_LABEL: Record<string, string> = {
  read: 'Reading',
  draft: 'Drafting',
  'content.publish': 'Content publishing',
  'audience.publish': 'Audience publishing',
  'send.broadcast': 'Broadcast sends',
  'send.direct': 'Direct sends',
  'journey.live': 'Live journeys',
  'experience.live': 'Live experiences',
  spend: 'Spend',
  'data.write': 'Data writes',
  settings: 'Settings changes',
  destructive: 'Destructive actions',
};

/** The classes shown in the ceilings table, in the order the design lists them. */
export const CEILING_CLASSES = Object.keys(ACTION_CLASS_LABEL);

/** The action classes a mandate sets a level for (reading is never granted; #223). */
export const MANDATE_CLASSES = [
  'draft',
  'content.publish',
  'audience.publish',
  'send.broadcast',
  'send.direct',
  'journey.live',
  'experience.live',
  'spend',
  'data.write',
  'settings',
  'destructive',
] as const;
export type MandateClass = (typeof MANDATE_CLASSES)[number];

/** Level 0–4 in words (design §3.3). */
export const AUTONOMY_LEVEL = ['Observe', 'Propose', 'Act with veto', 'Act within limits', 'Run the loop'] as const;
export const DEFAULT_LEVEL = 1;

export const levelLabel = (level: number) => AUTONOMY_LEVEL[level] ?? String(level);

/** The ceiling for a class, with the design's default of 1 (a person) for missing keys. */
export function levelFor(maxLevel: Autonomy['maxLevel'], actionClass: string): number {
  return (maxLevel as Partial<Record<string, number>>)[actionClass] ?? DEFAULT_LEVEL;
}

export const SWITCH_INFO: Record<Autonomy['switch'], { label: string; description: string; tone: Tone }> = {
  on: {
    label: 'On',
    description: 'Agents work as their grants and the approval policy allow.',
    tone: 'good',
  },
  propose_only: {
    label: 'Propose only',
    description: 'Every agent change beyond a draft waits for a person.',
    tone: 'warn',
  },
  off: {
    label: 'Off',
    description: 'Agents can only read; every change is refused.',
    tone: 'bad',
  },
};

/** The top-bar indicator, when the workspace is not fully on. */
export function switchNotice(settings: Autonomy | null): { label: string; tone: 'warn' | 'bad' } | null {
  if (!settings || settings.switch === 'on') return null;
  return settings.switch === 'propose_only' ? { label: 'Agents: propose only', tone: 'warn' } : { label: 'Agents: off', tone: 'bad' };
}

/** The policy's own estimate, in words: the summary first, then how many people it reaches. */
export function impactText(action: AgentAction): string | null {
  const summary = typeof action.impact.summary === 'string' ? action.impact.summary.trim() : '';
  const people = typeof action.impact.people === 'number' ? action.impact.people : null;
  const reach = people === null ? '' : `${people.toLocaleString('en-US')} ${people === 1 ? 'person' : 'people'}`;
  if (summary && reach) return `${summary} · ${reach}`;
  return summary || reach || null;
}
