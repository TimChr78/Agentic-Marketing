import { type Db, schema } from '@agentic-marketing/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { aiUsage } from '../src/commands';
import { reserveTokens, settleReservation, usedThisMonth } from '../src/providers';
import { finishIn, rememberReservation, settleStaleReservation } from '../src/steps';

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

suite('a late attempt cannot resurrect a completed row (#941 round 3)', () => {
  it('refuses the reservation link and releases the unused hold when the attempt lost the fence', async () => {
    const d = await createDisposableDb('ai_remember_fence');
    try {
      const db: Db = d.db;
      const workspace = d.workspace;
      await db.admin.query(
        `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region)
         VALUES ($1, $2, 'Budgeted', 'openai-compatible', 'https://llm.example.com/v1', '{"default":"m"}'::jsonb, '{}', '')`,
        [workspace, providerId],
      );
      const id = `aic_${'b'.repeat(32)}`;
      await db.withWorkspace(workspace, (tx) =>
        tx.insert(schema.aiCalls).values({
          workspaceId: workspace,
          id,
          kind: 'test',
          status: 'done',
          attempts: 2,
          input: {},
        }),
      );
      const base = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      const hold = await reserveTokens(db, workspace, providerId, 500, 60_000);
      // Attempt 1's snapshot still says attempts=1, but attempt 2 finished the row.
      const linked = await rememberReservation(db, { ...base, attempts: 1 }, hold, providerId);
      expect(linked).toBe(false);
      const row = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      expect(row.status).toBe('done');
      expect(row.leaseUntil).toBeNull();
      expect(row.reservationId).toBeNull();
      const holds = await db.withWorkspace(workspace, (tx) =>
        tx.select({ id: schema.aiTokenReservations.id }).from(schema.aiTokenReservations).where(sql`true`),
      );
      expect(holds).toHaveLength(0);
    } finally {
      await d.close().catch(() => undefined);
    }
  });
});

suite('recovery first and actual settlement reconcile exactly once (#941 round 3)', () => {
  it('replaces the estimate with the real usage and then counts the retry', async () => {
    const d = await createDisposableDb('ai_reconcile_estimate');
    try {
      const db: Db = d.db;
      const workspace = d.workspace;
      await db.admin.query(
        `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region)
         VALUES ($1, $2, 'Budgeted', 'openai-compatible', 'https://llm.example.com/v1', '{"default":"m"}'::jsonb, '{}', '')`,
        [workspace, providerId],
      );
      const id = `aic_${'c'.repeat(32)}`;
      await db.withWorkspace(workspace, (tx) =>
        tx.insert(schema.aiCalls).values({ workspaceId: workspace, id, kind: 'test', status: 'running', attempts: 2, input: {} }),
      );
      const base = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      const originalHold = await reserveTokens(db, workspace, providerId, 500, 60_000);
      const retryHold = await reserveTokens(db, workspace, providerId, 500, 60_000);
      await db.withWorkspace(workspace, (tx) =>
        tx.update(schema.aiCalls).set({ reservationId: originalHold, providerId }).where(eq(schema.aiCalls.id, id)),
      );
      const attempt2 = { ...base, attempts: 2, reservationId: originalHold, inputTokens: 0, outputTokens: 0 };

      // Recovery wins first: 500 is recorded as an estimate and the hold is kept as estimated.
      const recovered = await settleStaleReservation(db, attempt2);
      expect(recovered.inputTokens).toBe(500);
      const estimated = await db.withWorkspace(workspace, (tx) =>
        tx
          .select({ estimated: schema.aiTokenReservations.estimatedTokens })
          .from(schema.aiTokenReservations)
          .where(eq(schema.aiTokenReservations.id, originalHold)),
      );
      expect(estimated[0]?.estimated).toBe(500);

      // The original returns with its real 700: replace the estimate, not add to it.
      let writerRan = false;
      await settleReservation(
        db,
        workspace,
        originalHold,
        async () => {
          writerRan = true;
        },
        { providerId, callId: id, usage: { inputTokens: 700, outputTokens: 0 } },
      );
      expect(writerRan).toBe(false);
      const afterActual = (
        await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id)))
      )[0]!;
      expect(afterActual.inputTokens).toBe(700);

      // The retry then adds its own 200. Final total is actual 700 + actual 200, exactly once.
      await settleReservation(
        db,
        workspace,
        retryHold,
        (tx) => finishIn(tx, recovered, null, { status: 'fallback', inputTokens: 200, outputTokens: 0, providerId }),
        { providerId },
      );
      const row = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      expect(row.inputTokens).toBe(900);
      const holds = await db.withWorkspace(workspace, (tx) =>
        tx.select({ id: schema.aiTokenReservations.id }).from(schema.aiTokenReservations).where(sql`true`),
      );
      expect(holds).toHaveLength(0);
    } finally {
      await d.close().catch(() => undefined);
    }
  });
});

suite('the first settlement fixes a call’s billing period (#941 round 4)', () => {
  it('keeps a November estimate, retry and December correction in November, and bills a plain December call in December', async () => {
    const d = await createDisposableDb('ai_billing_period');
    try {
      const db: Db = d.db;
      const workspace = d.workspace;
      await db.admin.query(
        `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, region)
         VALUES ($1, $2, 'Budgeted', 'openai-compatible', 'https://llm.example.com/v1', '{"default":"m"}'::jsonb, '{}', '')`,
        [workspace, providerId],
      );
      const now = new Date();
      const previousMonthDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      const previousDay = previousMonthDay.toISOString().slice(0, 10);
      const currentDay = now.toISOString().slice(0, 10);
      const id = `aic_${'d'.repeat(32)}`;
      const originalHold = `rsv_${'e'.repeat(32)}`;
      // November recovery: the estimate is already on the row and the hold is marked estimated.
      await db.withWorkspace(workspace, async (tx) => {
        await tx.insert(schema.aiCalls).values({
          workspaceId: workspace,
          id,
          kind: 'test',
          status: 'running',
          attempts: 2,
          model: 'november-probe',
          providerId,
          inputTokens: 500,
          outputTokens: 0,
          usageEstimated: true,
          billedAt: previousMonthDay,
          input: {},
        });
        await tx.insert(schema.aiTokenReservations).values({
          workspaceId: workspace,
          id: originalHold,
          providerId,
          tokens: 500,
          estimatedTokens: 500,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        });
      });
      const base = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;

      // November retry: +200 tokens must stay in November.
      const retryHold = await reserveTokens(db, workspace, providerId, 500, 60_000);
      await settleReservation(
        db,
        workspace,
        retryHold,
        (tx) =>
          finishIn(tx, base, null, {
            status: 'fallback',
            inputTokens: 120,
            outputTokens: 80,
            model: 'november-probe',
            providerId,
          }),
        { providerId },
      );

      // December correction: 70/30 replaces the 500 estimate, still in November.
      let writerRan = false;
      await settleReservation(
        db,
        workspace,
        originalHold,
        async () => {
          writerRan = true;
        },
        { providerId, callId: id, usage: { inputTokens: 70, outputTokens: 30 } },
      );
      expect(writerRan).toBe(false);

      const scenario = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, id))))[0]!;
      expect(scenario.inputTokens + scenario.outputTokens).toBe(300);
      expect(scenario.billedAt?.toISOString().slice(0, 10)).toBe(previousDay);

      // A plain call first settled in December lands in December.
      const plainId = `aic_${'f'.repeat(32)}`;
      await db.withWorkspace(workspace, (tx) =>
        tx.insert(schema.aiCalls).values({ workspaceId: workspace, id: plainId, kind: 'test', status: 'running', attempts: 1, input: {} }),
      );
      const plain = (await db.withWorkspace(workspace, (tx) => tx.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, plainId))))[0]!;
      const plainHold = await reserveTokens(db, workspace, providerId, 100, 60_000);
      await settleReservation(
        db,
        workspace,
        plainHold,
        (tx) => finishIn(tx, plain, null, { status: 'fallback', inputTokens: 50, outputTokens: 0, model: 'december-probe', providerId }),
        { providerId },
      );

      expect(await db.withWorkspace(workspace, (tx) => usedThisMonth(tx, providerId))).toBe(50);
      const usage = await db.withWorkspace(workspace, (tx) => aiUsage.handler({ days: 60 }, { tx } as never));
      const scenarioRows = usage.days.filter((row) => row.model === 'november-probe');
      expect(scenarioRows).toEqual([expect.objectContaining({ day: previousDay, inputTokens: 190, outputTokens: 110 })]);
      const plainRows = usage.days.filter((row) => row.model === 'december-probe');
      expect(plainRows).toEqual([expect.objectContaining({ day: currentDay, inputTokens: 50, outputTokens: 0 })]);
    } finally {
      await d.close().catch(() => undefined);
    }
  });
});
