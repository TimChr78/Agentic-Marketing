import type { PolicyDecision } from '@agentic-marketing/db';
import { z } from 'zod';

// The policy engine (ADR-0016, #216): one decision for every agent write, measured in
// consequences. `decide` is pure so the rules can be tested without a database; the executor
// supplies the action class, the impact estimate, the workspace's autonomy settings and the
// agent's counters.
//
// Phase 17 has no mandates yet. An agent without a mandate behaves as before (the workspace
// approval policy decides publishing); on top of that the engine enforces the autonomy switch,
// the audience threshold and the per-agent limits, and explains every escalation.

/** What a command changes in the world (design §3.2). */
export const ACTION_CLASSES = [
  'read',
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
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Classes whose actions reach people, so the audience threshold and message limits apply. */
export const REACH_CLASSES: readonly ActionClass[] = ['send.broadcast', 'send.direct', 'journey.live'];

/** An estimate of what one call would do, computed before it runs (design §4.2). */
export interface Impact {
  /** Overrides the command's class, e.g. requestPublish depends on the artifact type. */
  actionClass?: ActionClass;
  /** People the action reaches (recipients, enrolled or waiting participants). */
  people?: number;
  /** Whether the action can be undone after it ran (a sent message cannot). */
  reversible?: boolean;
  /** A short human description, shown with holds and in the ledger. */
  summary?: string;
}

export const AutonomySwitch = z.enum(['on', 'propose_only', 'off']);
export type AutonomySwitch = z.infer<typeof AutonomySwitch>;

/** Workspace autonomy ceilings (#215). Stored in workspaces.autonomy; missing keys take the defaults. */
export const AutonomySettings = z.object({
  switch: AutonomySwitch.default('on').describe(
    'on: agents work as their grants allow; propose_only: every agent change beyond a draft needs a person; off: agents can only read',
  ),
  maxLevel: z
    .partialRecord(z.enum(ACTION_CLASSES), z.number().int().min(0).max(4))
    .default({})
    .describe(
      'Highest autonomy level a mandate may grant per action class (0 observe … 4 run the loop). Missing classes: 1 (propose). Applies to mandates (Phase 18); agents without a mandate follow the approval policy',
    ),
  allowLoops: z.boolean().default(false).describe('Whether any mandate may grant level 4 (run the loop)'),
  audienceThreshold: z
    .number()
    .int()
    .min(0)
    .default(1000)
    .describe('An agent action reaching more people than this needs a person, whatever the approval policy'),
  limits: z
    .object({
      changesPerDay: z.number().int().min(0).default(500).describe('Agent changes (beyond drafts) per agent per 24 hours'),
      messagesPerDay: z.number().int().min(0).default(1000).describe('Messages an agent may send itself per 24 hours'),
    })
    .default({ changesPerDay: 500, messagesPerDay: 1000 }),
});
export type AutonomySettings = z.output<typeof AutonomySettings>;

/** The workspace's settings with defaults filled in; unreadable stored values fall back to the defaults. */
export function autonomySettings(stored: unknown): AutonomySettings {
  const parsed = AutonomySettings.safeParse(stored ?? {});
  return parsed.success ? parsed.data : AutonomySettings.parse({});
}

/** What an agent did in the last 24 hours, from the ledger. */
export interface AgentCounters {
  changes: number;
  messages: number;
}

export interface PolicyInput {
  command: string;
  actionClass: ActionClass;
  impact: Impact;
  settings: AutonomySettings;
  counters: AgentCounters;
  /** The command can turn "ask" into an approval request (artifacts.requestPublish and bundles). */
  approvable: boolean;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  actionClass: ActionClass;
  reasons: string[];
  impact: Impact;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function decide(input: PolicyInput): PolicyOutcome {
  const { actionClass, impact, settings, counters } = input;
  const out = (decision: PolicyDecision, reasons: string[]): PolicyOutcome => ({ decision, actionClass, reasons, impact });
  if (actionClass === 'read') return out('allow', []);
  if (settings.switch === 'off')
    return out('deny', [
      'Agents are switched off in this workspace: they can only read. A person can switch them on in Settings → Agents.',
    ]);
  if (actionClass === 'draft') return out('allow', []);

  const ask: string[] = [];
  if (settings.switch === 'propose_only')
    ask.push('This workspace is set to propose-only: every agent change beyond a draft needs a person.');
  if (counters.changes >= settings.limits.changesPerDay)
    ask.push(`This agent made ${fmt(counters.changes)} changes in the last 24 hours, its limit is ${fmt(settings.limits.changesPerDay)}.`);
  const people = impact.people ?? 0;
  if (REACH_CLASSES.includes(actionClass) && people > settings.audienceThreshold)
    ask.push(`This reaches ${fmt(people)} people, above the workspace’s threshold of ${fmt(settings.audienceThreshold)} for agents.`);
  if (actionClass === 'send.direct' && counters.messages + people > settings.limits.messagesPerDay)
    ask.push(
      `This agent sent ${fmt(counters.messages)} messages in the last 24 hours; ${fmt(people)} more would pass its limit of ${fmt(settings.limits.messagesPerDay)}.`,
    );

  if (!ask.length) return out('allow', []);
  if (input.approvable) return out('ask', ask);
  return out('deny', [
    ...ask,
    `${input.command} cannot wait for an approval, so a person has to do it, or raise the limit in Settings → Agents.`,
  ]);
}
