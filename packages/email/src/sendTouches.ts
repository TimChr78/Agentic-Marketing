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

/**
 * The facts a direct send adds to its ledger row after the handler ran (#265, #279): the message
 * it created, and whether the message reached anyone. A suppressed or failed gateway result
 * (`status`) did not go out, so it must not count towards the agent's daily message limit.
 */
export function directSendLedger(out: { messageId: string; status: string; duplicate?: boolean }) {
  // A retry with the same idempotency key returns the earlier message and sends nothing (#294).
  const sent = !out.duplicate && out.status !== 'suppressed' && out.status !== 'failed';
  return { messageId: out.messageId, people: sent ? 1 : 0 };
}

/**
 * The impact of a direct send before it runs: one person, or none when the idempotency key was
 * already used, since the gateway then returns the earlier message without sending again (#294).
 * The policy engine decides before the handler, so a retry must not be judged as a new message.
 */
export async function directSendImpact(tx: Tx, input: { templateId: string; idempotencyKey?: string }, channel: DirectSendChannel) {
  const retry = input.idempotencyKey
    ? (
        await tx
          .select({ id: schema.messages.id })
          .from(schema.messages)
          .where(eq(schema.messages.idempotencyKey, input.idempotencyKey))
          .limit(1)
      ).length > 0
    : false;
  return { people: retry ? 0 : 1, reversible: false, touches: await sendTouches(tx, input.templateId, channel) };
}
