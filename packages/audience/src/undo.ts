import { registerUndoHandler } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';

// Reversing an agent's broadcast publish (ADR-0016 §5.4, #255): a scheduled send is cancelled
// before it goes out, a running one stops after the current batch. What was already sent cannot
// be recalled; the ledger and this error say so plainly.

registerUndoHandler(async (ctx, undo) => {
  if (undo.kind !== 'cancel_send') return null;
  const [run] = await ctx.tx
    .select()
    .from(schema.broadcastRuns)
    .where(and(eq(schema.broadcastRuns.workspaceId, ctx.principal.workspaceId), eq(schema.broadcastRuns.broadcastId, undo.broadcastId)))
    .for('update');
  if (!run) return `Broadcast ${undo.broadcastId} had no scheduled send to cancel.`;
  if (run.status === 'done') throw new AppError('conflict', 'Messages already sent cannot be recalled.');
  if (run.status === 'running' || run.status === 'scheduled') {
    await ctx.tx
      .update(schema.broadcastRuns)
      .set({ status: 'cancelled', finishedAt: new Date(), leaseUntil: null })
      .where(eq(schema.broadcastRuns.broadcastId, undo.broadcastId));
    return run.status === 'running'
      ? `Stopped the rest of broadcast ${undo.broadcastId}; messages already sent cannot be recalled.`
      : `Cancelled the scheduled send of broadcast ${undo.broadcastId}.`;
  }
  return `Broadcast ${undo.broadcastId} was already ${run.status}; no send to cancel.`;
});
