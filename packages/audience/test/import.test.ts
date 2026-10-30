import type { CommandContext } from '@agentic-marketing/commands';
import type { Tx } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { describe, expect, it } from 'vitest';
import { IMPORTED, importProfiles } from '../src/import';

// Row parsing, consent columns and the event shaping are pure once the two published-singleton
// lookups return nothing and the bus is a recorder; no Postgres or network is involved.

/** Every publishedSingleton lookup in the handler finds no published artefact. */
function emptyTx(): Tx {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => [] }),
      }),
    }),
  } as unknown as Tx;
}

async function run(rows: unknown[], label = 'Kit export 2026-10-22') {
  const published: BusEvent[] = [];
  const ctx = {
    principal: { type: 'user', userId: 'usr_1', workspaceId: 'ws_01', role: 'owner', permissions: new Set() },
    tx: emptyTx(),
    services: {
      bus: {
        publish: async (items: BusEvent[]) => {
          published.push(...items);
        },
      },
    },
  } as unknown as CommandContext;
  const out = await importProfiles.handler({ label, rows: rows as never }, ctx);
  return { out, published };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  email: 'Ada@Example.com',
  traits: { firstName: 'Ada', plan: 'pro' },
  consent: [
    {
      purpose: 'marketing_email',
      status: 'granted',
      recordedAt: '2026-01-02T03:04:05.000Z',
      proof: { system: 'Kit', form: 'Homepage' },
    },
  ],
  ...overrides,
});

const keyOf = (messageId: string, suffix: string) => new RegExp(`^imp:([0-9a-f]{32}):${suffix}$`).exec(messageId)?.[1];

describe('import row validation', () => {
  const parse = (rows: unknown[], label: string | undefined = 'Kit export') =>
    importProfiles.input.safeParse(label === undefined ? { rows } : { label, rows });

  it('accepts an e-mail-only row and fills in traits and consent', () => {
    const parsed = parse([{ email: 'ada@example.com' }]);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rows[0]).toEqual({ email: 'ada@example.com', traits: {}, consent: [] });
  });

  it('requires a label and at least one row', () => {
    expect(parse([{ email: 'ada@example.com' }], '').success).toBe(false);
    expect(importProfiles.input.safeParse({ rows: [{ email: 'ada@example.com' }] }).success).toBe(false);
    expect(parse([], 'Kit export').success).toBe(false);
    expect(parse([{ email: 'ada@example.com' }], 'x'.repeat(201)).success).toBe(false);
    expect(parse([{ email: 'ada@example.com' }], 'x'.repeat(200)).success).toBe(true);
  });

  it('caps a call at 5,000 rows', () => {
    expect(parse(Array.from({ length: 5_001 }, (_, i) => ({ email: `p${i}@example.com` }))).success).toBe(false);
    expect(parse(Array.from({ length: 5_000 }, (_, i) => ({ email: `p${i}@example.com` }))).success).toBe(true);
  });

  it('requires a real e-mail address of at most 320 characters', () => {
    for (const email of ['ada', 'ada@', '@example.com', '', 'ada@example', `${'a'.repeat(310)}@example.com`]) {
      expect(parse([{ email }]).success, email).toBe(false);
    }
    expect(parse([{ email: `${'a'.repeat(308)}@example.com` }]).success).toBe(true);
  });

  it('validates the optional user id and the traits object', () => {
    expect(parse([{ email: 'ada@example.com', userId: 'usr_1' }]).success).toBe(true);
    expect(parse([{ email: 'ada@example.com', userId: '' }]).success).toBe(false);
    expect(parse([{ email: 'ada@example.com', userId: 'u'.repeat(201) }]).success).toBe(false);
    expect(parse([{ email: 'ada@example.com', traits: { firstName: 'Ada' } }]).success).toBe(true);
    expect(parse([{ email: 'ada@example.com', traits: ['Ada'] }]).success).toBe(false);
  });

  it('validates the consent columns: purpose key, status, timestamp and proof', () => {
    const consent = (overrides: Record<string, unknown> = {}) => ({ purpose: 'marketing_email', status: 'granted', ...overrides });

    expect(parse([{ email: 'ada@example.com', consent: [consent()] }]).success).toBe(true);
    expect(parse([{ email: 'ada@example.com', consent: [consent({ status: 'withdrawn' })] }]).success).toBe(true);
    expect(parse([{ email: 'ada@example.com', consent: [consent({ status: 'objected' })] }]).success).toBe(true);

    for (const status of ['yes', 'GRANTED', 'pending']) {
      expect(parse([{ email: 'ada@example.com', consent: [consent({ status })] }]).success, status).toBe(false);
    }
    for (const purpose of ['Marketing Email', '1marketing', 'marketing-email', 'marketing_email ', '']) {
      expect(parse([{ email: 'ada@example.com', consent: [consent({ purpose })] }]).success, purpose).toBe(false);
    }
    expect(parse([{ email: 'ada@example.com', consent: [consent({ recordedAt: 'yesterday' })] }]).success).toBe(false);
    expect(parse([{ email: 'ada@example.com', consent: [consent({ proof: 'Kit' })] }]).success).toBe(false);
  });

  it('allows at most ten consent entries per row', () => {
    const consent = (purpose: string) => ({ purpose, status: 'granted' });
    expect(parse([{ email: 'ada@example.com', consent: Array.from({ length: 10 }, (_, i) => consent(`purpose_${i}`)) }]).success).toBe(
      true,
    );
    expect(parse([{ email: 'ada@example.com', consent: Array.from({ length: 11 }, (_, i) => consent(`purpose_${i}`)) }]).success).toBe(
      false,
    );
  });
});

describe('import event shaping', () => {
  it('publishes an identify and a consent event with a stable id, lowercased e-mail and sealed personal traits', async () => {
    const { out, published } = await run([row()]);

    expect(out).toMatchObject({ accepted: 1, rejected: [] });
    expect(out.batchId).toMatch(/^imp_[0-9a-f]{32}$/);
    expect(published).toHaveLength(2);

    const [identify, consent] = published;
    expect(identify).toMatchObject({ type: 'identify', name: 'identify', workspaceId: 'ws_01' });
    expect(identify?.anonymousId).toMatch(/^import:[0-9a-f]{24}$/);
    expect(identify?.userId).toBe('');
    expect(identify?.traits).toEqual({ plan: 'pro' });
    expect(identify?.piiTraits).toEqual({ email: 'ada@example.com', firstName: 'Ada' });

    expect(consent).toMatchObject({ type: 'track', name: IMPORTED, userId: '' });
    expect(consent?.properties).toMatchObject({
      label: 'Kit export 2026-10-22',
      imported_by: 'usr_1',
      consent: [
        {
          purpose: 'marketing_email',
          status: 'granted',
          recordedAt: '2026-01-02T03:04:05.000Z',
          proof: { system: 'Kit', form: 'Homepage' },
        },
      ],
    });

    const key = keyOf(identify?.messageId ?? '', 'identify');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(keyOf(consent?.messageId ?? '', 'consent')).toBe(key);
  });

  it('re-importing the same row produces the same message ids, so the bus deduplicates it', async () => {
    const first = await run([row()]);
    const second = await run([row()]);
    expect(second.published.map((e) => e.messageId)).toEqual(first.published.map((e) => e.messageId));
    expect(second.published.map((e) => e.name)).toEqual(['identify', IMPORTED]);
  });

  it('changes the id when the row changes, so an updated trait is not swallowed as a duplicate', async () => {
    const first = await run([row()]);
    const second = await run([row({ traits: { firstName: 'Ada', plan: 'free' } })]);
    expect(second.published[0]?.messageId).not.toBe(first.published[0]?.messageId);
  });

  it('uses the given user id instead of an anonymous import id', async () => {
    const { published } = await run([row({ userId: 'usr_existing', consent: [] })]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'identify', userId: 'usr_existing', anonymousId: '' });
  });

  it('publishes only the identify event for a row without consent', async () => {
    const { out, published } = await run([row({ consent: [] })]);
    expect(out.accepted).toBe(1);
    expect(published.map((e) => e.name)).toEqual(['identify']);
  });

  it('rejects a row whose consent names a purpose this workspace does not have', async () => {
    const { out, published } = await run([row({ consent: [{ purpose: 'not_a_purpose', status: 'granted' }] })]);
    expect(out).toEqual({
      batchId: expect.stringMatching(/^imp_/),
      accepted: 0,
      rejected: [{ index: 0, error: 'unknown purpose "not_a_purpose"' }],
    });
    expect(published).toEqual([]);
  });

  it('reports the original row index and counts a row once, even when it publishes two events', async () => {
    const { out, published } = await run([row(), row({ email: 'grace@example.com', consent: [{ purpose: 'nope', status: 'granted' }] })]);
    expect(out).toMatchObject({ accepted: 1, rejected: [{ index: 1, error: 'unknown purpose "nope"' }] });
    expect(published.every((e) => e.messageId.startsWith('imp:'))).toBe(true);
    expect(published).toHaveLength(2);
  });
});
