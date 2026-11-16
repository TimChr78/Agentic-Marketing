import { type Db, schema } from '@agentic-marketing/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { reserveTokens, settleReservation } from '../src/providers';
import { finishIn, settleStaleReservation } from '../src/steps';

// #941 review: a retry that took over an expired lease must not overwrite the original attempt's
// usage with its stale claim snapshot. Both attempts were billed, so both add their tokens; only
// the attempt that still owns the row writes the terminal outcome.

const suite = hasTestDatabase() ? describe : describe.skip;
const providerId = `aip_${'6'.repeat(32)}`;

suite('overlapping attempts settle both usages (#941 review)', () => {
  it('adds a late original’s usage and reloads it before the retry settles', async () => {
    const d = await createDisposableDb('ai_steps_overlap');
    try {
      const db: Db = d.db;
      const workspace = d.workspace;
      await db.admin.query(
        `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region)
         VALUES ($1, $2, 'Budgeted', 'openai-compatible', 'https://llm.example.com/v1', '{"default":"m"}'::jsonb, '{}', '')`,
        [workspace, providerId],
      );
      const id = `aic_${'7'.repeat(32)}`;
      // Exactly the queue's shape plus the crash state: no provider yet, attempts already at 2
      // because the retry claimed the row after the first lease expired.
      await db.withWorkspace(workspace, (tx) =>
        tx.insert(schema.aiCalls).values({
          workspaceId: workspace,
          id,
          kind: 'test',
          status: 'running',
          attempts: 2,
          input: { runId: `run_${'8'.repeat(32)}`, index: 0, test: 'retry' },
        }),
      );
      const base = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      // Attempt 1's snapshot predates the retry claim; attempt 2's snapshot predates attempt 1's
      // late settlement and still points at attempt 1's hold.
      const originalHold = await reserveTokens(db, workspace, providerId, 500, 60_000);
      const secondHold = await reserveTokens(db, workspace, providerId, 500, 60_000);
      const attempt1 = { ...base, attempts: 1, reservationId: originalHold, inputTokens: 0, outputTokens: 0 };
      const attempt2 = { ...base, attempts: 2, reservationId: originalHold, inputTokens: 0, outputTokens: 0 };

      // Attempt 1 is late: it adds 100/20 but cannot write status/output (attempt 2 owns the row).
      await settleReservation(
        db,
        workspace,
        originalHold,
        (tx) => finishIn(tx, attempt1, null, { status: 'fallback', inputTokens: 100, outputTokens: 20, providerId }),
        { providerId },
      );
      // Attempt 2 recovers the (now gone) hold and must reload the row, not its zero snapshot.
      const recovered = await settleStaleReservation(db, { ...attempt2, reservationId: originalHold });
      expect(recovered.inputTokens).toBe(100);
      expect(recovered.outputTokens).toBe(20);
      expect(recovered.status).toBe('running');
      await settleReservation(
        db,
        workspace,
        secondHold,
        (tx) => finishIn(tx, recovered, null, { status: 'fallback', inputTokens: 50, outputTokens: 10, providerId }),
        { providerId },
      );

      const row = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      expect(row.inputTokens).toBe(150);
      expect(row.outputTokens).toBe(30);
      expect(row.status).toBe('fallback');
      const held = await db.withWorkspace(workspace, (tx) =>
        tx.select({ id: schema.aiTokenReservations.id }).from(schema.aiTokenReservations).where(sql`true`),
      );
      expect(held).toHaveLength(0);
      // Provider is persisted for the month's usage even though the queued row had none.
      expect(row.providerId).toBe(providerId);
    } finally {
      await d.close().catch(() => undefined);
    }
  });
});
