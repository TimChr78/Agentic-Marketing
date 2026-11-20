import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { EXPIRED_HOLD_GRACE_MS, sweepExpiredTokenReservations } from '../src/providers';

// #1080: a live hold (`estimated_tokens IS NULL`) is deleted only after its own deadline plus a
// grace window. The four flows that never link their hold to an `ai_calls` row (decision, copilot,
// hosted and independent check) could otherwise leave dead rows for ever. A linked hold is left to
// `settleStaleReservation`, and an estimate is left to `cleanupExpiredEstimates`.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('expired_holds');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const insertHold = (id: string, expiresAt: Date, estimatedTokens: number | null = null) =>
  d.db.admin.query(
    `INSERT INTO ai_token_reservations (workspace_id, id, provider_id, tokens, estimated_tokens, expires_at)
     VALUES ($1, $2, 'aip_expired_holds', 100, $3, $4)`,
    [d.workspace, id, estimatedTokens, expiresAt],
  );

describe.skipIf(!hasTestDatabase())('expired live budget holds (#1080)', () => {
  it('deletes an expired live hold past the grace window and keeps every hold that still matters', async () => {
    const now = Date.now();
    const pastGrace = new Date(now - EXPIRED_HOLD_GRACE_MS - 60_000);
    // A crashed decision/copilot/hosted/check call: no ai_calls row points at it.
    await insertHold('rsv_dead', pastGrace);
    // Still inside the grace window: an in-flight call may yet settle it.
    await insertHold('rsv_recent', new Date(now - 30_000));
    // Not expired at all.
    await insertHold('rsv_live', new Date(now + 60_000));
    // An estimate is cleanupExpiredEstimates' row, not a live hold.
    await insertHold('rsv_estimate', pastGrace, 100);
    // A linked hold belongs to settleStaleReservation: deleting it would lose billed usage.
    await insertHold('rsv_linked', pastGrace);
    await d.db.admin.query(
      `INSERT INTO ai_calls (workspace_id, id, kind, status, reservation_id)
       VALUES ($1, 'call_linked', 'copilot', 'running', 'rsv_linked')`,
      [d.workspace],
    );

    expect(await sweepExpiredTokenReservations(d.db.admin)).toBe(1);

    const left = await d.db.admin.query<{ id: string }>('SELECT id FROM ai_token_reservations WHERE workspace_id = $1 ORDER BY id', [
      d.workspace,
    ]);
    expect(left.rows.map((row) => row.id)).toEqual(['rsv_estimate', 'rsv_linked', 'rsv_live', 'rsv_recent']);
  }, 60_000);
});
