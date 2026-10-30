import type { ActionClass, CommandContext, Impact } from '@agentic-marketing/commands';
import type { Tx } from '@agentic-marketing/db';

// What publishing an artifact changes in the world (ADR-0016, design §3.2 and §4.2), for the
// policy engine. The class follows the artifact type; packages that know an artifact's reach
// (broadcast recipients, journey participants) register an estimator in the services.

declare module '@agentic-marketing/commands' {
  interface Services {
    /** Reach estimators per artifact type, registered by the packages that own the type. */
    artifactImpact?: Partial<Record<string, (tx: Tx, artifactId: string, version: number) => Promise<Impact>>>;
  }
}

const CLASS_BY_TYPE: Record<string, ActionClass> = {
  broadcast: 'send.broadcast',
  journey: 'journey.live',
  segment: 'audience.publish',
  audience_sync: 'audience.publish',
  experience: 'experience.live',
  purposes: 'settings',
  delivery_policy: 'settings',
  tracking_plan: 'settings',
  conversion_map: 'settings',
};

/** Types whose publishing a mandate can never make autonomous (design §3.2, the fixed rule). */
const NEEDS_PERSON = ['purposes', 'delivery_policy', 'tracking_plan', 'conversion_map', 'agent_mandate'];

/** The class of publishing an artifact of this type. */
export const publishClass = (type: string): ActionClass => CLASS_BY_TYPE[type] ?? 'content.publish';

// When several artifacts are published together, the bundle counts as its riskiest member.
const RANK: ActionClass[] = ['content.publish', 'experience.live', 'audience.publish', 'settings', 'journey.live', 'send.broadcast'];

export async function publishImpact(
  ctx: Pick<CommandContext, 'tx' | 'services'>,
  members: { id: string; type: string; version: number }[],
): Promise<Impact> {
  let actionClass: ActionClass = 'content.publish';
  let people: number | undefined;
  const summaries: string[] = [];
  const touches: Required<NonNullable<Impact['touches']>> = { segments: [], purposes: [], topics: [], channels: [], artifacts: [] };
  for (const m of members) {
    const cls = publishClass(m.type);
    if (RANK.indexOf(cls) > RANK.indexOf(actionClass)) actionClass = cls;
    touches.artifacts.push({ id: m.id, type: m.type });
    const estimate = await ctx.services.artifactImpact?.[m.type]?.(ctx.tx, m.id, m.version);
    if (estimate?.people !== undefined) people = Math.max(people ?? 0, estimate.people);
    if (estimate?.summary) summaries.push(estimate.summary);
    for (const k of ['segments', 'purposes', 'topics', 'channels'] as const) touches[k].push(...(estimate?.touches?.[k] ?? []));
  }
  const needsPerson = members.some((m) => NEEDS_PERSON.includes(m.type))
    ? 'Consent, purposes, delivery caps and tracking settings always need a person, whatever the mandate.'
    : undefined;
  return {
    actionClass,
    ...(people !== undefined ? { people } : {}),
    reversible: actionClass !== 'send.broadcast',
    ...(summaries.length ? { summary: summaries.join('; ') } : {}),
    touches,
    ...(needsPerson ? { needsPerson } : {}),
  };
}

/** The approval note, with why the policy engine sent the change to a person. */
export function noteWithPolicy(note: string, ctx: Pick<CommandContext, 'policy'>): string {
  if (ctx.policy?.decision !== 'ask') return note;
  return `${note}\n\nNeeds a person: ${ctx.policy.reasons.join(' ')}`.slice(0, 2000);
}
