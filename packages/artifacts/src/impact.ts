import type { ActionClass, CommandContext, Impact } from '@agentic-marketing/commands';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

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
  ctx: Pick<CommandContext, 'tx' | 'services'> & { principal?: CommandContext['principal'] },
  members: { id: string; type: string; version: number }[],
): Promise<Impact> {
  let actionClass: ActionClass = 'content.publish';
  let people: number | undefined;
  const summaries: string[] = [];
  const touches: Required<NonNullable<Impact['touches']>> = { segments: [], purposes: [], topics: [], channels: [], artifacts: [] };
  for (const m of members) {
    const cls = publishClass(m.type);
    if (RANK.indexOf(cls) > RANK.indexOf(actionClass)) actionClass = cls;
    // Every publish touches the artifact itself. A segment is also exactly the audience it names:
    // a mandate scopes audiences by segment id, so it touches its own id (no estimator needed).
    // An experience reports only this artifact, because the scope's channels are delivery
    // channels (email, sms, push) and there is no experience channel to check.
    const [live] = await ctx.tx
      .select({ publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, m.id));
    touches.artifacts.push({ id: m.id, type: m.type, created: live?.publishedVersion == null && (await draftedByCaller(ctx, m.id)) });
    if (m.type === 'segment') touches.segments.push(m.id);
    const estimate = await ctx.services.artifactImpact?.[m.type]?.(ctx.tx, m.id, m.version);
    if (estimate?.people !== undefined) people = Math.max(people ?? 0, estimate.people);
    if (estimate?.summary) summaries.push(estimate.summary);
    for (const k of ['segments', 'purposes', 'topics', 'channels'] as const) touches[k].push(...(estimate?.touches?.[k] ?? []));
  }
  const learning = await learningOf(ctx.tx, members);
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
    ...(learning.length ? { learning } : {}),
  };
}

/**
 * Whether the calling agent drafted this artifact's first version itself (#325). Level 4 may create
 * new artifacts outside the mandate's artifact list, but only its own: a never-published draft by a
 * person or another agent is not a creation of this agent and stays in the list's scope.
 */
async function draftedByCaller(ctx: { tx: Tx; principal?: CommandContext['principal'] }, artifactId: string): Promise<boolean> {
  const p = ctx.principal;
  if (p?.type !== 'agent' || !p.clientId) return false;
  const [first] = await ctx.tx
    .select({ authorType: schema.artifactVersions.authorType, authorClient: schema.artifactVersions.authorClient })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, 1)));
  return first?.authorType === 'agent' && first.authorClient === p.clientId;
}

const MEASURED = ['journey', 'broadcast', 'experience'];

/** The content fields the learning rules read, from journeys, broadcasts, experiences and campaigns. */
interface HoldoutFields {
  controlGroup?: { percent?: number };
  subjectTest?: unknown;
  holdoutPercent?: number;
  members?: { artifactId: string }[];
}

/**
 * The holdouts of the journeys, broadcasts and experiences being published (#257): a journey's own
 * control group or its campaign's, a broadcast's campaign control group or subject test, an
 * experience's holdout. A member published together with its campaign counts the bundled campaign.
 */
async function learningOf(tx: Tx, members: { id: string; type: string; version: number }[]): Promise<NonNullable<Impact['learning']>> {
  const measured = members.filter((m) => MEASURED.includes(m.type));
  if (!measured.length) return [];
  const contentOf = async (m: { id: string; version: number }) => {
    const [v] = await tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, m.id), eq(schema.artifactVersions.number, m.version)));
    return (v?.content ?? {}) as HoldoutFields;
  };
  // Campaign control groups: published campaigns, and campaigns in this same bundle.
  const campaignControl = new Map<string, number>();
  const ids = measured.map((m) => m.id);
  const published = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(
      and(
        eq(schema.artifacts.type, 'campaign'),
        eq(schema.artifacts.archived, false),
        isNotNull(schema.artifacts.publishedVersion),
        sql`${schema.artifactVersions.content} ? 'controlGroup'`,
      ),
    );
  const bundled = await Promise.all(members.filter((m) => m.type === 'campaign').map(contentOf));
  for (const c of [...published.map((p) => p.content as HoldoutFields), ...bundled])
    for (const m of c.members ?? [])
      if (ids.includes(m.artifactId) && c.controlGroup?.percent)
        campaignControl.set(m.artifactId, Math.max(campaignControl.get(m.artifactId) ?? 0, c.controlGroup.percent));
  const out: NonNullable<Impact['learning']> = [];
  for (const m of measured) {
    const c = await contentOf(m);
    const fromCampaign = campaignControl.get(m.id) ?? 0;
    if (m.type === 'journey') out.push({ id: m.id, type: m.type, controlPercent: Math.max(c.controlGroup?.percent ?? 0, fromCampaign) });
    if (m.type === 'broadcast') out.push({ id: m.id, type: m.type, controlPercent: fromCampaign, subjectTest: !!c.subjectTest });
    if (m.type === 'experience') out.push({ id: m.id, type: m.type, controlPercent: c.holdoutPercent ?? 0 });
  }
  return out;
}

/** The approval note, with why the policy engine sent the change to a person. */
export function noteWithPolicy(note: string, ctx: Pick<CommandContext, 'policy'>): string {
  if (ctx.policy?.decision === 'ask') return `${note}\n\nNeeds a person: ${ctx.policy.reasons.join(' ')}`.slice(0, 2000);
  if (ctx.policy?.decision === 'hold')
    return `${note}\n\nHeld for a veto window by the agent's mandate: ${ctx.policy.reasons.join(' ')}`.slice(0, 2000);
  return note;
}
