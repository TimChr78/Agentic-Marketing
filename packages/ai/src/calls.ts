import { newId } from '@agentic-marketing/core';
import { type Db, schema } from '@agentic-marketing/db';

// Every model call goes through one log row: the copilot turn, a hosted agent run, a journey step
// or an independent check. Recording it in its own committed transaction keeps the call visible in
// `ai.calls` and in the provider's monthly usage once the reservation is released.

export type AiCallRecord = Omit<typeof schema.aiCalls.$inferInsert, 'workspaceId' | 'id'> & { id?: string };

/** Writes one ai_calls row for the workspace and returns its id. */
export async function recordAiCall(db: Db, workspaceId: string, values: AiCallRecord): Promise<string> {
  const { id = newId('aic'), ...rest } = values;
  await db.withWorkspace(workspaceId, (tx) => tx.insert(schema.aiCalls).values({ workspaceId, id, ...rest }));
  return id;
}
