import { activeMandate, dueHolds, runHeldChange, systemContext } from '@agentic-marketing/artifacts';
import { autonomySettings, type Services } from '@agentic-marketing/commands';
import { type Db, schema } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';

// Held agent changes (level 2, act with veto; ADR-0016, #225): when the veto window ends without a
// person rejecting the change, it publishes, after re-checking that the agent may still act.

export async function runHoldsOnce(deps: { db: Db; services: Services }) {
  let ran = 0;
  for (const { workspace_id: ws, id } of await dueHolds(deps.db)) {
    try {
      const out = await deps.db.withWorkspace(ws, (tx) =>
        runHeldChange(systemContext(tx, ws, deps.services), id, async (agentId) => {
          const [w] = await tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
          const settings = autonomySettings(w?.autonomy);
          if (settings.switch !== 'on') return `the workspace is set to ${settings.switch.replace('_', ' ')}`;
          if (!(await activeMandate(tx, agentId))) return 'the agent no longer has an active mandate';
          return null;
        }),
      );
      if (out.status !== 'not_due') ran++;
      logger.info({ workspace: ws, approval: id, ...out }, 'held agent change processed');
    } catch (err) {
      logger.warn({ err, workspace: ws, approval: id }, 'held agent change failed');
    }
  }
  return ran;
}

export async function runHolds(deps: { db: Db; services: Services }, signal: AbortSignal, tickMs = 30_000) {
  while (!signal.aborted) {
    await runHoldsOnce(deps).catch((err) => logger.error({ err }, 'held agent changes round failed'));
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
