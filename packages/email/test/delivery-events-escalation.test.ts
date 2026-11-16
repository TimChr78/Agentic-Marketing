import { createDb, type Db } from '@agentic-marketing/db';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { applyDeliveryEvents, logSuppressionEscalation } from '../src/deliveryEvents';

// #906 review round 2 (A3): the STOP-to-bounce escalation is derived from the mutation itself
// (`RETURNING` with an insert/update marker), and the log is emitted by the caller only after the
// transaction commits. A rolled-back escalation therefore leaves no log, and a STOP that another
// connection inserts before the upsert is still reported.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let db: Db;
const sid = `SM${'d'.repeat(32)}`;
const hash = 'a'.repeat(64);
const kp = {} as KeyProvider;

const bounce = (at: string) =>
  [{ eventId: `${sid}:bounced`, type: 'bounced' as const, bounce: 'hard' as const, providerMessageId: sid, at }] as const;

const apply = (at: string) => db.withWorkspace(d.workspace, (tx) => applyDeliveryEvents(tx, [...bounce(at)], 'test', kp));

/** What every caller does: log the returned transitions only after `withWorkspace` committed. */
async function applyAndLog(at: string) {
  const result = await apply(at);
  for (const escalation of result.escalations) logSuppressionEscalation(escalation);
  return result;
}

const reasonOf = async () =>
  (
    await d.db.admin.query<{ reason: string }>('SELECT reason FROM suppressions WHERE workspace_id = $1 AND value_hash = $2', [
      d.workspace,
      hash,
    ])
  ).rows[0]?.reason;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_escalation');
  db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 4 });
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, status, provider_message_id, recipient_hash)
     VALUES ($1, $2, $3, 'sms', 'marketing_sms', 'sent', $4, $5)`,
    [d.workspace, `msg-${sid}`, `idem-${sid}`, sid, hash],
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('STOP suppression escalation logging (A3)', () => {
  it('logs nothing when the transaction rolls back after the escalation', async () => {
    await d.db.admin.query(
      `INSERT INTO suppressions (workspace_id, channel, value_hash, reason, at)
       VALUES ($1, 'sms', $2, 'stop', '2026-01-01T00:00:00Z')`,
      [d.workspace, hash],
    );
    const logged = vi.spyOn(logger, 'info');
    try {
      await expect(
        db.withWorkspace(d.workspace, async (tx) => {
          const result = await applyDeliveryEvents(tx, [...bounce('2026-01-05T00:00:00Z')], 'test', kp);
          expect(result.escalations).toHaveLength(1);
          throw new Error('rolled back after the escalation');
        }),
      ).rejects.toThrow('rolled back after the escalation');
      expect(logged.mock.calls.filter(([, m]) => String(m).includes('suppression escalated'))).toHaveLength(0);
      // The escalation itself rolled back too.
      expect(await reasonOf()).toBe('stop');
    } finally {
      logged.mockRestore();
    }
  });

  it('logs exactly once for a STOP that another connection inserted before the upsert', async () => {
    const logged = vi.spyOn(logger, 'info');
    try {
      // A second pool/connection writes the STOP row while the delivery is being applied.
      await d.db.admin.query(
        `INSERT INTO suppressions (workspace_id, channel, value_hash, reason, at)
         VALUES ($1, 'sms', $2, 'stop', '2026-01-01T00:00:00Z')
         ON CONFLICT (workspace_id, channel, value_hash) DO UPDATE SET reason = 'stop'`,
        [d.workspace, hash],
      );
      await applyAndLog('2026-01-05T00:00:00Z');
      const escalationLogs = logged.mock.calls.filter(([, m]) => String(m).includes('suppression escalated'));
      expect(escalationLogs).toHaveLength(1);
      expect(escalationLogs[0]![0]).toMatchObject({ workspace: d.workspace, channel: 'sms', previous: 'stop', reason: 'hard_bounce' });
      expect(await reasonOf()).toBe('hard_bounce');
    } finally {
      logged.mockRestore();
    }
  });

  it('does not log or move a second bounce', async () => {
    const logged = vi.spyOn(logger, 'info');
    try {
      const result = await applyAndLog('2026-01-06T00:00:00Z');
      expect(result.escalations).toEqual([]);
      expect(logged.mock.calls.filter(([, m]) => String(m).includes('suppression escalated'))).toHaveLength(0);
      const row = (
        await d.db.admin.query<{ reason: string; at: Date }>(
          'SELECT reason, at FROM suppressions WHERE workspace_id = $1 AND value_hash = $2',
          [d.workspace, hash],
        )
      ).rows[0]!;
      expect(row.reason).toBe('hard_bounce');
      expect(row.at.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    } finally {
      logged.mockRestore();
    }
  });
});
