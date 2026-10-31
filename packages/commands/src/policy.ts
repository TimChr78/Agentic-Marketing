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
  /** What the action touches, for a mandate's scope (design §3.4). */
  touches?: {
    segments?: string[];
    purposes?: string[];
    topics?: string[];
    channels?: string[];
    artifacts?: { id: string; type: string }[];
  };
  /** Never autonomous whatever the mandate: consent, purposes, delivery caps, credentials (design §3.2). */
  needsPerson?: string;
  /**
   * The holdouts of what is published (#257): per journey, broadcast or experience, the share held
   * out (its own control group, or its campaign's) and whether a broadcast tests subject lines.
   */
  learning?: { id: string; type: string; controlPercent: number; subjectTest?: boolean }[];
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
  /** Broadcast sends it ran itself, and the people its previous one reached (for recipientGrowth). */
  sends?: number;
  previousSendPeople?: number | null;
}

/** The parts of an agent's active mandate the engine needs (the artifact is in packages/artifacts). */
export interface MandateView {
  id: string;
  version: number;
  levels: Partial<Record<ActionClass, number>>;
  scope: {
    segments: string[];
    purposes: string[];
    topics: string[];
    channels: string[];
    artifactTypes: string[];
    artifacts: string[];
  };
  limits: {
    recipientsPerSend?: number;
    recipientGrowth?: number;
    sendsPerDay?: number;
    changesPerDay?: number;
    messagesPerDay?: number;
  };
  holdWindow: string;
  independentCheck: boolean;
  guardrails: { unsubscribeRate?: number; complaintRate?: number; bounceRate?: number; window: string; minSent: number };
  purpose: string;
  /** Learning rules (#257): holdouts the agent's journeys, broadcasts and experiences must have. */
  learning?: { journeyControlPercent?: number; broadcastHoldout?: boolean; experienceHoldoutPercent?: number };
  /**
   * Shadow mode (#256): for these classes (or all, when true) the mandate's decision is only
   * recorded; the action is decided as if there were no mandate, so a person decides as before.
   */
  shadow?: boolean | ActionClass[];
}

/**
 * The guardian's cap on an agent (#253): its levels are capped at `cap` for every class, and at
 * `irreversibleCap` for actions that cannot be undone, until a person clears it.
 */
export interface AgentGuard {
  cap: number;
  irreversibleCap?: number;
  reason: string;
}

/** What the mandate would have decided in shadow mode (#256). */
export interface ShadowOutcome {
  decision: PolicyDecision;
  level?: number;
  reasons: string[];
  mandateId: string;
  mandateVersion: number;
}

/** Classes whose actions cannot be undone once they ran: working hours apply to them. */
const IRREVERSIBLE: readonly ActionClass[] = ['send.broadcast', 'send.direct', 'spend', 'destructive'];
/** Classes a mandate can never make autonomous (design §3.2, the fixed rule). */
const ALWAYS_A_PERSON: readonly ActionClass[] = ['destructive', 'settings'];

export interface PolicyInput {
  command: string;
  actionClass: ActionClass;
  impact: Impact;
  settings: AutonomySettings;
  counters: AgentCounters;
  /** The command can turn "ask" into an approval request (artifacts.requestPublish and bundles). */
  approvable: boolean;
  /** The agent's active mandate, if any; without one the approval policy decides as before. */
  mandate?: MandateView;
  /** Why the agent's recent sends breach the mandate's guardrails, computed before deciding. */
  guardrailBreach?: string | null;
  /** Whether now is outside the mandate's working hours or on a blackout date. */
  outsideHours?: string | null;
  /** The guardian's cap on this agent, if it has acted and no person has cleared it yet (#253). */
  guard?: AgentGuard | null;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  actionClass: ActionClass;
  reasons: string[];
  impact: Impact;
  /** The level the mandate grants for this action after every cap (0–4); undefined without a mandate. */
  level?: number;
  /** Allowed by a mandate (level 3+): the change runs without the approval policy (ADR-0016). */
  autonomous?: boolean;
  mandate?: { id: string; version: number; holdWindow: string; independentCheck: boolean };
  /** Shadow mode: what the mandate would have decided; the decision above is the one that applied. */
  shadow?: ShadowOutcome;
}

/** Whether a mandate runs this action class in shadow mode. */
export function inShadow(mandate: Pick<MandateView, 'shadow'>, actionClass: ActionClass): boolean {
  return mandate.shadow === true || (Array.isArray(mandate.shadow) && mandate.shadow.includes(actionClass));
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function decide(input: PolicyInput): PolicyOutcome {
  const { actionClass, impact, settings, counters, mandate } = input;
  const out = (decision: PolicyDecision, reasons: string[], extra: Partial<PolicyOutcome> = {}): PolicyOutcome => ({
    decision,
    actionClass,
    reasons,
    impact,
    ...(mandate
      ? {
          mandate: { id: mandate.id, version: mandate.version, holdWindow: mandate.holdWindow, independentCheck: mandate.independentCheck },
        }
      : {}),
    ...extra,
  });
  if (actionClass === 'read') return out('allow', []);
  if (settings.switch === 'off')
    return out('deny', [
      'Agents are switched off in this workspace: they can only read. A person can switch them on in Settings → Agents.',
    ]);
  if (mandate && inShadow(mandate, actionClass))
    return actionClass === 'draft' ? decide({ ...input, mandate: undefined }) : decideInShadow(input, mandate);
  if (mandate && (mandate.levels.draft ?? 1) === 0 && actionClass === 'draft')
    return out('deny', ['This agent’s mandate is observe-only (level 0): it may read but not draft.'], { level: 0 });
  if (actionClass === 'draft') return out('allow', []);
  if (mandate) return decideWithMandate(input, mandate, out);

  const ask: string[] = [];
  // Without a mandate there is no veto window: any guardian cap below 3 sends the change to a person.
  const guard = input.guard;
  if (guard && (guard.cap < 3 || (guard.irreversibleCap !== undefined && guard.irreversibleCap < 3 && IRREVERSIBLE.includes(actionClass))))
    ask.push(guard.reason);
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

const LEVEL_NAMES = ['observe', 'propose', 'act with veto', 'act within limits', 'run the loop'];

/** Outside the scope a mandate grants: each entry is a reason (design §3.4). */
function scopeViolations(impact: Impact, scope: MandateView['scope']): string[] {
  const t = impact.touches ?? {};
  const out: string[] = [];
  const outside = (kind: string, values: string[] | undefined, allowed: string[], emptyMeansAny: boolean) => {
    if (!values?.length) return;
    if (!allowed.length && emptyMeansAny) return;
    const bad = values.filter((v) => !allowed.includes(v));
    if (bad.length) out.push(`${kind} ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} outside this agent’s mandate.`);
  };
  outside('Audience', t.segments, scope.segments, false);
  outside('Purpose', t.purposes, scope.purposes, true);
  outside('Topic', t.topics, scope.topics, true);
  outside('Channel', t.channels, scope.channels, false);
  // Both lists restrict when set: a matching type does not excuse an id outside the list (#232).
  for (const a of t.artifacts ?? []) {
    if (scope.artifactTypes.length && !scope.artifactTypes.includes(a.type))
      out.push(`Changing a ${a.type} is outside this agent’s mandate.`);
    if (scope.artifacts.length && !scope.artifacts.includes(a.id)) out.push(`${a.id} is outside this agent’s mandate.`);
  }
  return out;
}

/** What the mandate's learning rules require and the published change lacks (#257). */
function learningGaps(impact: Impact, rules: MandateView['learning']): string[] {
  if (!rules) return [];
  const out: string[] = [];
  for (const l of impact.learning ?? []) {
    if (l.type === 'journey' && rules.journeyControlPercent && l.controlPercent < rules.journeyControlPercent)
      out.push(
        `Journey ${l.id} holds out ${l.controlPercent}% of entrants; the mandate requires a control group of at least ${rules.journeyControlPercent}% (controlGroup.percent).`,
      );
    if (l.type === 'broadcast' && rules.broadcastHoldout && l.controlPercent === 0 && !l.subjectTest)
      out.push(`Broadcast ${l.id} has neither a holdout (its campaign’s control group) nor a subject test; the mandate requires one.`);
    if (l.type === 'experience' && rules.experienceHoldoutPercent && l.controlPercent < rules.experienceHoldoutPercent)
      out.push(
        `Experience ${l.id} holds out ${l.controlPercent}% of visitors; the mandate requires at least ${rules.experienceHoldoutPercent}% (holdoutPercent).`,
      );
  }
  return out;
}

function decideWithMandate(
  input: PolicyInput,
  mandate: MandateView,
  out: (decision: PolicyDecision, reasons: string[], extra?: Partial<PolicyOutcome>) => PolicyOutcome,
): PolicyOutcome {
  const { actionClass, impact, settings, counters } = input;
  const reasons: string[] = [];
  const granted = mandate.levels[actionClass] ?? 1;
  let ceiling = settings.maxLevel[actionClass] ?? 1;
  if (ceiling === 4 && !settings.allowLoops) ceiling = 3;
  let level = Math.min(granted, ceiling);
  if (granted > ceiling)
    reasons.push(`The mandate grants level ${granted} (${LEVEL_NAMES[granted]}), the workspace allows at most ${ceiling}.`);
  const capAt = (max: number, reason: string) => {
    if (level > max) level = max;
    reasons.push(reason);
  };
  // A mandate limit lowers the level by one, but never below propose: at level 1 the action already
  // waits for a person, who sees the reason. Observe (0) is only ever granted, not reached (#246).
  const dropOne = (reason: string) => {
    level = Math.max(Math.min(level, 1), level - 1);
    reasons.push(reason);
  };

  if (settings.switch === 'propose_only')
    capAt(1, 'This workspace is set to propose-only: every agent change beyond a draft needs a person.');
  if (ALWAYS_A_PERSON.includes(actionClass)) capAt(1, `A ${actionClass} change always needs a person, whatever the mandate.`);
  if (impact.needsPerson) capAt(1, impact.needsPerson);
  for (const v of scopeViolations(impact, mandate.scope)) capAt(1, v);
  for (const v of learningGaps(impact, mandate.learning)) capAt(1, v);

  const people = impact.people ?? 0;
  if (REACH_CLASSES.includes(actionClass) && people > settings.audienceThreshold)
    capAt(1, `This reaches ${fmt(people)} people, above the workspace’s threshold of ${fmt(settings.audienceThreshold)} for agents.`);
  if (counters.changes >= settings.limits.changesPerDay)
    capAt(
      1,
      `This agent made ${fmt(counters.changes)} changes in the last 24 hours, the workspace limit is ${fmt(settings.limits.changesPerDay)}.`,
    );
  if (actionClass === 'send.direct' && counters.messages + people > settings.limits.messagesPerDay)
    capAt(
      1,
      `This agent sent ${fmt(counters.messages)} messages in the last 24 hours, the workspace limit is ${fmt(settings.limits.messagesPerDay)}.`,
    );

  const l = mandate.limits;
  if (l.recipientsPerSend !== undefined && REACH_CLASSES.includes(actionClass) && people > l.recipientsPerSend)
    dropOne(`This reaches ${fmt(people)} people; the mandate allows ${fmt(l.recipientsPerSend)} per send.`);
  if (l.recipientGrowth !== undefined && actionClass === 'send.broadcast' && counters.previousSendPeople)
    if (people > l.recipientGrowth * counters.previousSendPeople)
      dropOne(
        `This reaches ${fmt(people)} people, more than ${l.recipientGrowth}× the agent’s previous send (${fmt(counters.previousSendPeople)}).`,
      );
  if (l.sendsPerDay !== undefined && actionClass === 'send.broadcast' && (counters.sends ?? 0) >= l.sendsPerDay)
    dropOne(`This agent ran ${fmt(counters.sends ?? 0)} sends in the last 24 hours; the mandate allows ${fmt(l.sendsPerDay)}.`);
  if (l.changesPerDay !== undefined && counters.changes >= l.changesPerDay)
    dropOne(`This agent made ${fmt(counters.changes)} changes in the last 24 hours; the mandate allows ${fmt(l.changesPerDay)}.`);
  if (l.messagesPerDay !== undefined && actionClass === 'send.direct' && counters.messages + people > l.messagesPerDay)
    dropOne(`This agent sent ${fmt(counters.messages)} messages in the last 24 hours; the mandate allows ${fmt(l.messagesPerDay)}.`);

  if (input.guardrailBreach) capAt(1, input.guardrailBreach);
  const guard = input.guard;
  if (guard) {
    const max =
      guard.irreversibleCap !== undefined && IRREVERSIBLE.includes(actionClass) ? Math.min(guard.cap, guard.irreversibleCap) : guard.cap;
    if (max < 4) capAt(max, guard.reason);
  }
  if (input.outsideHours && IRREVERSIBLE.includes(actionClass)) capAt(2, input.outsideHours);

  if (level <= 0) return out('deny', [...reasons, `The mandate gives this agent level 0 (observe) for ${actionClass}.`], { level });
  if (level === 1) {
    if (input.approvable)
      return out('ask', reasons.length ? reasons : [`The mandate gives level 1 (propose) for ${actionClass}.`], { level });
    return out('deny', [...reasons, `${input.command} cannot wait for an approval at level 1, so a person has to do it.`], { level });
  }
  if (level === 2) {
    if (input.approvable)
      return out('hold', [`Held for a veto window of ${mandate.holdWindow} (level 2, act with veto).`, ...reasons], { level });
    return out('deny', [...reasons, `${input.command} cannot be held for a veto window; level 3 is needed to run it, or a person can.`], {
      level,
    });
  }
  return out('allow', reasons, { level, autonomous: true });
}

/**
 * Shadow mode (#256): the mandate's decision, with its levels as granted (the workspace ceiling is
 * what a person raises once the shadow record supports it), is returned as `shadow`; the decision
 * that applies is the one without a mandate.
 */
function decideInShadow(input: PolicyInput, mandate: MandateView): PolicyOutcome {
  const { actionClass, settings } = input;
  const granted = mandate.levels[actionClass] ?? 1;
  const would = decideWithMandate(
    {
      ...input,
      settings: { ...settings, maxLevel: { ...settings.maxLevel, [actionClass]: Math.max(settings.maxLevel[actionClass] ?? 1, granted) } },
    },
    mandate,
    (decision, reasons, extra = {}) => ({ decision, actionClass, reasons, impact: input.impact, ...extra }),
  );
  const actual = decide({ ...input, mandate: undefined, outsideHours: undefined, guardrailBreach: undefined });
  return {
    ...actual,
    shadow: {
      decision: would.decision,
      ...(would.level !== undefined ? { level: would.level } : {}),
      reasons: would.reasons,
      mandateId: mandate.id,
      mandateVersion: mandate.version,
    },
  };
}
