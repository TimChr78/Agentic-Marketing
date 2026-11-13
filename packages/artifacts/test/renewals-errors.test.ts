import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { renewMandates } from '../src/renewals';

// #885: agents.renewMandates builds its own per-mandate result and audit entry, so the executor's
// sanitisation never sees them. A failure there used to become an AppError carrying the raw text,
// which went into both the response and the audit log. Only an AppError's message may survive; an
// unexpected failure becomes the fixed internal marker the executor uses.
const SECRET = 'driver failure: password=probe-secret';
const FIXED = 'The command failed with an unexpected error.';
const MANDATE = `mnd_${'a'.repeat(32)}`;

/** A transaction that answers the lock read, then the per-mandate read with `failure`. */
function fakeTx(failure: unknown) {
  const audits: { error?: string | null; ok: boolean }[] = [];
  let reads = 0;
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
    for: async () => {
      reads += 1;
      // The first locked read is the whole set; the second is this mandate's own row.
      if (reads === 1) return [];
      throw failure;
    },
  };
  const tx = {
    select: () => chain,
    execute: async () => undefined,
    insert: () => ({
      values: async (row: { error?: string | null; ok: boolean }) => {
        audits.push(row);
      },
    }),
  };
  return { tx, audits };
}

function context(tx: unknown): CommandContext {
  return {
    tx,
    principal: { workspaceId: 'ws_test', userId: 'usr_owner', type: 'user', clientId: null, permissions: new Set<string>() },
    surface: 'rest',
  } as unknown as CommandContext;
}

const renew = (ctx: CommandContext) =>
  renewMandates.handler(
    { mandateIds: [MANDATE], validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(), note: 'Renew for the quarter' },
    ctx,
  );

describe('agents.renewMandates failure text (#885)', () => {
  it('answers and audits an unexpected failure as the fixed internal marker', async () => {
    const { tx, audits } = fakeTx(new Error(SECRET));
    const out = await renew(context(tx));
    expect(out.renewed).toEqual([{ mandateId: MANDATE, ok: false, status: null, version: null, validUntil: null, error: FIXED }]);
    // The audit entry this command writes itself must carry the same fixed marker, not the driver's
    // text: any member with audit:read can see it.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ ok: false, error: `internal: ${FIXED}` });
    expect(JSON.stringify({ out, audits })).not.toContain('probe-secret');
  });

  it('keeps an AppError’s message, which is written for the person renewing', async () => {
    const reason = `Mandate ${MANDATE} has no published version to renew.`;
    const { tx, audits } = fakeTx(new AppError('conflict', reason));
    const out = await renew(context(tx));
    expect(out.renewed[0]).toMatchObject({ ok: false, error: reason });
    expect(audits[0]).toMatchObject({ ok: false, error: `conflict: ${reason}` });
  });
});
