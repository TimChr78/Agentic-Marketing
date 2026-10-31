import { activeMandate, dueHolds, type HeldCheck, runHeldChange, systemContext } from '@agentic-marketing/artifacts';
import { agentCounters, autonomySettings, decide, IRREVERSIBLE, REACH_CLASSES, type Services } from '@agentic-marketing/commands';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';

// Held agent changes (level 2, act with veto; ADR-0016, #225): when the veto window ends without a
// person rejecting the change, it is decided again as of now (#262): the current mandate, its
// working hours, the agent's counters, guardrails and any guardian cap. Outside working hours it
// waits for the next opening; anything the mandate no longer allows goes to a person.

export async function runHoldsOnce(deps: { db: Db; services: Services }) {
  let ran = 0;
  for (const { workspace_id: ws, id } of await dueHolds(deps.db)) {
    try {
      const out = await deps.db.withWorkspace(ws, (tx) =>
        runHeldChange(systemContext(tx, ws, deps.services), id, (agentId, held) => checkHeld(tx, deps.services, ws, agentId, held)),
      );
      if (out.status !== 'not_due') ran++;
      logger.info({ workspace: ws, approval: id, ...out }, 'held agent change processed');
    } catch (err) {
      logger.warn({ err, workspace: ws, approval: id }, 'held agent change failed');
    }
  }
  return ran;
}

async function checkHeld(
  tx: Tx,
  services: Services,
  workspaceId: string,
  agentId: string,
  held: Parameters<Parameters<typeof runHeldChange>[2]>[1],
): Promise<HeldCheck> {
  const [w] = await tx.select({ autonomy: schema.workspaces.autonomy }).from(schema.workspaces);
  const settings = autonomySettings(w?.autonomy);
  if (settings.switch !== 'on') return { person: `the workspace is set to ${settings.switch.replace('_', ' ')}` };
  const mandate = await activeMandate(tx, agentId);
  if (!mandate) return { person: 'the agent no longer has an active mandate' };
  if (!held) return { person: 'the decision that held it is no longer in the ledger' };
  if (mandate.outsideHours && IRREVERSIBLE.includes(held.actionClass)) return { wait: mandate.outsideHours };
  const [agent] = await tx.select({ guard: schema.agents.guard }).from(schema.agents).where(eq(schema.agents.id, agentId));
  const guardrailBreach =
    REACH_CLASSES.includes(held.actionClass) && services.mandateGuardrails
      ? await services.mandateGuardrails(tx, workspaceId, agentId, mandate.view)
      : null;
  const policy = decide({
    command: 'artifacts.requestPublish',
    actionClass: held.actionClass,
    impact: held.impact,
    settings,
    counters: await agentCounters(tx, agentId, { excludeId: held.id }),
    approvable: true,
    mandate: mandate.view,
    outsideHours: null,
    guardrailBreach,
    guard: agent?.guard ?? null,
  });
  // Its window has passed, so a hold now counts as allowed; in shadow mode a person decides as before.
  if (!policy.shadow && (policy.decision === 'allow' || policy.decision === 'hold')) return { run: true };
  const reasons = policy.shadow ? ['its mandate is now in shadow mode'] : policy.reasons;
  return { person: `the mandate no longer allows it: ${reasons.join(' ')}` };
}

export async function runHolds(deps: { db: Db; services: Services }, signal: AbortSignal, tickMs = 30_000) {
  while (!signal.aborted) {
    await runHoldsOnce(deps).catch((err) => logger.error({ err }, 'held agent changes round failed'));
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
