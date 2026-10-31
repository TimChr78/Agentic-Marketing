import { AppError } from '@agentic-marketing/core';
import { type AgentUndo, schema, type Tx } from '@agentic-marketing/db';
import { eq } from 'drizzle-orm';
import type { CommandContext } from './registry';

// Undo for agent actions (ADR-0016 §5.4, #255): the ledger records how to reverse what an agent
// did, and `agents.undo` runs it through the same commands and checks as the original publish.
//
// A package that can reverse something registers a handler when it loads. A handler returns null
// when the reversal is not its kind; otherwise it returns what it did, in words a person can read.
// Everything runs inside the caller's transaction, so a reversal that fails leaves nothing behind.

export type UndoHandler = (ctx: CommandContext, undo: AgentUndo) => Promise<string | null>;

/** Handlers for the reversal kinds a package can run (artifacts: republish, audience: cancel a send). */
export const undoHandlers: UndoHandler[] = [];

export function registerUndoHandler(handler: UndoHandler): void {
  undoHandlers.push(handler);
}

/** A republish recorded before 0.5.2 does not say which version the agent published (#291, #301). */
const isLegacy = (undo: AgentUndo): boolean =>
  undo.kind === 'republish' ? undo.publishedVersion === undefined : undo.kind === 'group' && undo.items.some(isLegacy);

/**
 * Whether an action can be undone now: it happened, it was not undone yet, its reversal is known,
 * and it is not a pre-0.5.2 record that `agents.undo` would refuse (#301).
 */
export function isUndoable(action: { ok: boolean; decision: string; undo: AgentUndo | null; undoneAt: Date | null }): boolean {
  if (!action.ok || action.decision === 'deny' || action.undoneAt !== null || !action.undo) return false;
  if (action.undo.kind === 'none' || isLegacy(action.undo)) return false;
  return action.undo.kind !== 'group' || action.undo.items.some((item) => item.kind !== 'none');
}

/**
 * Why a reversal the ledger offers would be refused now, or null (#305): a newer version of the
 * artifact went live since, it is no longer live, or the broadcast it would cancel has already sent.
 * The same checks `agents.undo` makes, read without locks so the activity list can show them.
 */
export async function undoBlocker(tx: Tx, undo: AgentUndo): Promise<string | null> {
  if (undo.kind === 'group') {
    for (const item of undo.items) {
      const reason = await undoBlocker(tx, item);
      if (reason) return reason;
    }
    return null;
  }
  if (undo.kind === 'republish') {
    const [a] = await tx
      .select({ publishedVersion: schema.artifacts.publishedVersion })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, undo.artifactId));
    if (a?.publishedVersion == null) return 'It is no longer live.';
    if (a.publishedVersion !== undo.publishedVersion) return `v${a.publishedVersion} was published since; change it by hand.`;
    return null;
  }
  if (undo.kind === 'cancel_send') {
    const [run] = await tx
      .select({ status: schema.broadcastRuns.status })
      .from(schema.broadcastRuns)
      .where(eq(schema.broadcastRuns.broadcastId, undo.broadcastId));
    if (run?.status === 'done') return 'Messages already sent cannot be recalled.';
  }
  return null;
}

/** Runs one reversal (or a group of them) in the caller's transaction and returns what happened. */
export async function runUndo(ctx: CommandContext, undo: AgentUndo): Promise<string[]> {
  if (undo.kind === 'none') throw new AppError('conflict', undo.reason);
  if (undo.kind === 'group') {
    const out: string[] = [];
    for (const item of undo.items) out.push(...(await runUndo(ctx, item)));
    if (!out.length) throw new AppError('conflict', 'This action has nothing to undo.');
    return out;
  }
  const results: string[] = [];
  for (const handler of undoHandlers) {
    const result = await handler(ctx, undo);
    if (result !== null) results.push(result);
  }
  if (!results.length) throw new AppError('conflict', `Nothing in this build can undo a “${undo.kind}” action.`);
  return results;
}

/** Collects how the handler's action can be reversed, for the executor to put in the ledger. */
export interface UndoCollector {
  set(undo: AgentUndo | null): void;
  get(): AgentUndo | null;
}

export function createUndoCollector(): UndoCollector {
  let current: AgentUndo | null = null;
  return {
    set(undo) {
      current = undo;
    },
    get: () => current,
  };
}
