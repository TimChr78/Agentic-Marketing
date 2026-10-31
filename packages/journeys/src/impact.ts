import type { Impact } from '@agentic-marketing/commands';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

// Reach of a journey, for the agent policy engine (ADR-0016 §3.4, #264). A journey reaches the
// people its trigger enrols and the channels of its steps, under its purpose; publishing a new
// version also moves the people already in it. The template topics are read from the templates.

type Touches = Required<NonNullable<Impact['touches']>>;

/** Segment ids inside a condition tree: a branch's condition or a waitUntil's, when they name segments. */
export function conditionSegments(condition: unknown): string[] {
  if (!condition || typeof condition !== 'object') return [];
  const c = condition as Record<string, unknown>;
  if (typeof c.segment === 'string') return [c.segment];
  return [c.all, c.any, c.not].flatMap((part) => (Array.isArray(part) ? part.flatMap(conditionSegments) : conditionSegments(part)));
}

/**
 * What a journey definition touches: its purpose, the channels of its e-mail, SMS and push steps,
 * the entry segment and the segments its branches and waits read, and the templates whose topics
 * it may use. Pure, so the derivation is testable without a database.
 */
export function journeyTouchesOf(definition: unknown): { touches: Touches; templates: string[] } {
  const def = (definition ?? {}) as { purpose?: unknown; nodes?: unknown };
  const nodes = Array.isArray(def.nodes) ? (def.nodes as { kind?: unknown; config?: unknown }[]) : [];
  const segments: string[] = [];
  const channels: string[] = [];
  const templates: string[] = [];
  for (const n of nodes) {
    const config = (n.config && typeof n.config === 'object' ? n.config : {}) as Record<string, unknown>;
    if (n.kind === 'trigger' && typeof config.segment === 'string') segments.push(config.segment);
    if (n.kind === 'branch') {
      if (typeof config.segment === 'string') segments.push(config.segment);
      segments.push(...conditionSegments(config.condition));
    }
    if (n.kind === 'waitUntil') segments.push(...conditionSegments(config.condition));
    if (n.kind === 'email' || n.kind === 'sms' || n.kind === 'push') {
      channels.push(n.kind);
      if (typeof config.template === 'string') templates.push(config.template);
    }
  }
  return {
    touches: {
      segments: [...new Set(segments)],
      purposes: typeof def.purpose === 'string' ? [def.purpose] : [],
      topics: [],
      channels: [...new Set(channels)],
      artifacts: [],
    },
    templates: [...new Set(templates)],
  };
}

/**
 * What a journey artifact version touches, for `enroll` (its published definition) and for
 * publishing (the version being published). Undefined when the version cannot be read.
 */
export async function journeyTouches(tx: Tx, artifactId: string, version?: number): Promise<Impact['touches']> {
  const [a] = await tx
    .select({ published: schema.artifacts.publishedVersion, latest: schema.artifacts.latestVersion })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  const number = version ?? a?.published ?? a?.latest;
  if (!number) return undefined;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, number)));
  if (!v) return undefined;
  const { touches, templates } = journeyTouchesOf(v.content);
  if (templates.length) {
    // A template reviewed in the same bundle is not published yet: fall back to its latest version.
    const rows = await tx
      .select({ topic: sql<string | null>`${schema.artifactVersions.content} ->> 'topic'` })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          sql`${schema.artifactVersions.number} = coalesce(${schema.artifacts.publishedVersion}, ${schema.artifacts.latestVersion})`,
        ),
      )
      .where(inArray(schema.artifacts.id, templates));
    for (const r of rows) if (r.topic) touches.topics.push(r.topic);
    touches.topics = [...new Set(touches.topics)];
  }
  return touches;
}

/**
 * Reach of publishing a journey version, for the agent policy engine (ADR-0016): the people
 * currently in the journey, whom the new version will move on, and what the definition touches.
 */
export async function journeyImpact(tx: Tx, artifactId: string, version?: number) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.journeyParticipants)
    .where(and(eq(schema.journeyParticipants.journeyId, artifactId), inArray(schema.journeyParticipants.status, ['ready', 'waiting'])));
  const touches = await journeyTouches(tx, artifactId, version);
  return { people: n, summary: `${n.toLocaleString('en-US')} people currently in the journey`, ...(touches ? { touches } : {}) };
}
