import { newId } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';

// Every model call goes through one log row: the copilot turn, a hosted agent run, a journey step
// or an independent check. Recording it in its own committed transaction keeps the call visible in
// `ai.calls` and in the provider's monthly usage once the reservation is released.

export type AiCallRecord = Omit<typeof schema.aiCalls.$inferInsert, 'workspaceId' | 'id'> & { id?: string };

/**
 * Writes one ai_calls row for the workspace and returns its id.
 *
 * `idempotent` turns a retry with the same id into a no-op: a caller that did not learn whether an
 * earlier commit landed (a failure after commit) can retry without writing the usage twice. The
 * row keeps its stable id, so one call is still one row.
 */
export async function recordAiCall(
  db: Db,
  workspaceId: string,
  values: AiCallRecord,
  opts: { idempotent?: boolean } = {},
): Promise<string> {
  const { id = newId('aic'), ...rest } = values;
  await db.withWorkspace(workspaceId, (tx) => {
    const insert = tx.insert(schema.aiCalls).values({ workspaceId, id, ...rest });
    return opts.idempotent ? insert.onConflictDoNothing({ target: [schema.aiCalls.workspaceId, schema.aiCalls.id] }) : insert;
  });
  return id;
}
