import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq, sql } from 'drizzle-orm';

/** What a direct send reports to the policy engine (ADR-0016 §3.4, #264, #278). */
export type DirectSendChannel = 'email' | 'sms' | 'push';

/**
 * The purpose and optional topic of a direct send's published template, and the channel it
 * reaches people on. `scopeViolations()` only rejects values present in `impact.touches`, so every
 * direct-send command must report them or a mandate scoped to e-mail would allow it. Without a
 * published template there is nothing to scope; the gateway refuses the send with
 * `not_published`.
 */
export async function sendTouches(tx: Tx, templateId: string, channel: DirectSendChannel) {
  const [row] = await tx
    .select({
      purpose: sql<string | null>`${schema.artifactVersions.content} ->> 'purpose'`,
      topic: sql<string | null>`${schema.artifactVersions.content} ->> 'topic'`,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.id, templateId));
  return {
    ...(row?.purpose ? { purposes: [row.purpose] } : {}),
    ...(row?.topic ? { topics: [row.topic] } : {}),
    channels: [channel],
  };
}
