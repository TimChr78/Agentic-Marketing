import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { reserveTokens, settleReservation, usedThisMonth } from '../src/providers';

// #941: monthly budget accounting. `usedThisMonth` used to sum `ai_calls` and live reservations in
// two statements under READ COMMITTED, so a settlement committing between them (insert usage +
// delete hold) was counted by neither. The sums are one statement now, and settlement takes the
// same per-provider advisory lock as reservation.

const suite = hasTestDatabase() ? describe : describe.skip;
const providerId = `aip_${'1'.repeat(32)}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withDb(fn: (db: Db, workspace: string) => Promise<void>) {
  const d = await createDisposableDb('ai_budget_accounting');
  try {
    await d.db.admin.query(
      `INSERT INTO ai_providers (workspace_id, id, name, kind, base_url, models, use_for, monthly_token_budget, region)
       VALUES ($1, $2, 'Budgeted', 'openai-compatible', 'https://llm.example.com/v1', '{"default":"m"}'::jsonb, '{}', NULL, '')`,
      [d.workspace, providerId],
    );
    await fn(d.db, d.workspace);
  } finally {
    await d.close().catch(() => undefined);
  }
}

const insertCall = (tx: Tx, workspace: string, values: { id: string; input: number; output: number; createdAt?: Date; billedAt?: Date }) =>
  tx.insert(schema.aiCalls).values({
    workspaceId: workspace,
    id: values.id,
    kind: 'test',
    status: 'done',
    providerId,
    inputTokens: values.input,
    outputTokens: values.output,
    createdAt: values.createdAt,
    billedAt: values.billedAt,
  });

/**
 * A Tx that runs `between` right after its first statement resolves: the settlement commits between
 * the usage sum and the reservation sum, exactly the interleaving the issue describes. A one-statement
 * implementation runs its query either side of the settlement, never in the gap.
 */
function settleAfterFirstStatement(tx: Tx, between: () => Promise<void>) {
  const state = { first: true };
  const wrap = (value: unknown): unknown => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    return new Proxy(value as object, {
      get(target, prop, receiver) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            (async () => {
              const result = await (target as PromiseLike<unknown>);
              if (state.first) {
                state.first = false;
                await between();
              }
              return result;
            })().then(resolve, reject);
          };
        }
        const found = Reflect.get(target, prop, receiver);
        if (typeof found !== 'function') return found;
        return (...args: unknown[]) => wrap(found.apply(target, args));
      },
    });
  };
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const found = Reflect.get(target, prop, receiver);
      if (prop !== 'select' && prop !== 'execute') return found;
      return (...args: unknown[]) => wrap(found.apply(target, args));
    },
  }) as Tx;
}

suite('monthly budget accounting (#941)', () => {
  it('counts a settlement that commits between the usage and reservation sums', async () => {
    await withDb(async (db, workspace) => {
      const reservation = await reserveTokens(db, workspace, providerId, 1000, 60_000);
      const settleBetween = () =>
        db.withWorkspace(workspace, async (tx) => {
          await insertCall(tx, workspace, { id: `aic_${'2'.repeat(32)}`, input: 700, output: 300, billedAt: new Date() });
          await tx.delete(schema.aiTokenReservations).where(sql`${schema.aiTokenReservations.id} = ${reservation}`);
        });
      const used = await db.withWorkspace(workspace, (tx) => usedThisMonth(settleAfterFirstStatement(tx, settleBetween), providerId));
      // Before the fix the first sum saw no usage and the second no reservation: 0.
      expect(used).toBe(1000);
    });
  });

  it('takes the per-provider budget lock when settling', async () => {
    await withDb(async (db, workspace) => {
      const reservation = await reserveTokens(db, workspace, providerId, 1000, 60_000);
      const lock = await db.admin.connect();
      let settled = false;
      try {
        await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`ai-budget:${providerId}`]);
        const settling = settleReservation(
          db,
          workspace,
          reservation,
          (tx) =>
            insertCall(tx, workspace, { id: `aic_${'3'.repeat(32)}`, input: 700, output: 300, billedAt: new Date() }).then(() => undefined),
          { providerId },
        ).then((outcome) => {
          settled = true;
          return outcome;
        });
        await sleep(300);
        expect(settled).toBe(false);
        const held = await db.withWorkspace(workspace, (tx) =>
          tx
            .select({ id: schema.aiTokenReservations.id })
            .from(schema.aiTokenReservations)
            .where(sql`${schema.aiTokenReservations.id} = ${reservation}`),
        );
        expect(held).toHaveLength(1);
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`ai-budget:${providerId}`]);
        expect(await settling).toBe('settled');
      } finally {
        await lock.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        lock.release();
      }
    });
  });

  it('attributes usage to the month it was billed in, not the month it was queued', async () => {
    await withDb(async (db, workspace) => {
      const monthStart = sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      await db.withWorkspace(workspace, async (tx) => {
        // Queued last month, never billed: falls back to created_at, so it stays in last month.
        await tx.execute(sql`
          INSERT INTO ai_calls (workspace_id, id, kind, status, provider_id, input_tokens, output_tokens, created_at)
          VALUES (${workspace}, ${`aic_${'4'.repeat(32)}`}, 'test', 'done', ${providerId}, 200, 100, ${monthStart} - interval '1 day')`);
        // Queued at 23:59 last month, settled now: this month.
        await tx.execute(sql`
          INSERT INTO ai_calls (workspace_id, id, kind, status, provider_id, input_tokens, output_tokens, created_at, billed_at)
          VALUES (${workspace}, ${`aic_${'5'.repeat(32)}`}, 'test', 'done', ${providerId}, 700, 300,
                  ${monthStart} - interval '1 minute', now())`);
      });
      expect(await db.withWorkspace(workspace, (tx) => usedThisMonth(tx, providerId))).toBe(1000);
    });
  });
});
