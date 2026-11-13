import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { calibration } from '../src/score';

// #885: ai.calibration wrapped an event-store failure into
// "ai.calibration could not read outcome events: <driver text>", an AppError whose message reached
// any reader with artifacts:read (and the audit log). The read failure is unexpected, so it now
// propagates and the executor answers and audits it as the sanitised internal failure.
const SECRET = 'driver failure: password=probe-secret';

const context = (failEvents: boolean): CommandContext => {
  const scored = {
    profileId: `prf_${'a'.repeat(32)}`,
    key: 'conversion_propensity',
    value: 0.5,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  let selects = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => {
          selects += 1;
          // The scores page first (order + limit); the identifier lookup is awaited directly.
          return selects === 1 ? { orderBy: () => ({ limit: async () => [scored] }) } : [];
        },
      }),
    }),
  };
  const events = {
    conversionEvents: async () => {
      if (failEvents) throw new Error(SECRET);
      return [];
    },
  };
  return { principal: { workspaceId: 'ws_test' }, tx, services: { events } } as unknown as CommandContext;
};

describe('ai.calibration event-store failures (#885)', () => {
  it('leaves an unexpected read failure to the executor instead of quoting it', async () => {
    const err = (await calibration
      .handler({ scoreKey: 'conversion_propensity', event: 'Order Completed', withinDays: 14, bins: 10, limit: 20_000 }, context(true))
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('still reports a calibration with no outcome events', async () => {
    const out = await calibration.handler(
      { scoreKey: 'conversion_propensity', event: 'Order Completed', withinDays: 14, bins: 10, limit: 20_000 },
      context(false),
    );
    expect(out).toMatchObject({ predictions: 1, positives: 0, baseRate: 0 });
  });
});
