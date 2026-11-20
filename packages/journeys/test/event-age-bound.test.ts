import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { assertJourneyEventAgeBound, JOURNEY_EVENT_MAX_AGE_DAYS, JOURNEY_EVENT_RETENTION_DAYS, schema } from '@agentic-marketing/db';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import { applyEvents, personCrypto, profileIdsForBatch, type ResolvedEvent } from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { journeyEventsTooOldCount } from '../src/metrics';
import { journeyHook, sweep, withinDeliveryAge } from '../src/runtime';

// #1027: the processed markers stop a redelivery from enrolling or waking someone twice, but
// retention prunes them 30 days after the event was applied. An event whose delivery is older than
// the bound below is ignored for both enrolment and waking, so a pruned marker can never let a
// replay apply the event a second time. Every case here is about that bound: what it refuses, what
// it still accepts, and how it relates to the retention it has to stay inside.

const MASTER_KEY = Buffer.alloc(32, 45).toString('base64');
const DAY_MS = 24 * 60 * 60 * 1000;

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const eventStore = { async insertJourneyEvents() {} } as unknown as EventStore;
const deps = () => ({ kp, events: eventStore });

/** Distinct receive times, all recent enough that the bound leaves them alone. */
const at = () => new Date(Date.now() - 60_000 + clock++ * 1000).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_event_age');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

beforeEach(async () => {
  if (!hasTestDatabase()) return;
  await d.db.admin.query('DELETE FROM journey_participants WHERE workspace_id = $1', [ws]);
  await d.db.admin.query('DELETE FROM journey_processed_events WHERE workspace_id = $1', [ws]);
});

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => {
  const timestamp = at();
  return {
    workspaceId: ws,
    sourceId: 'src_event_age',
    messageId: newId('evt'),
    type: 'track',
    name: 'Page Viewed',
    anonymousId: '',
    userId: '',
    timestamp,
    receivedAt: timestamp,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
    ...over,
  };
};

const runBatch = (events: BusEvent[]): Promise<ResolvedEvent[]> =>
  withPreparedKeys(
    async () => {
      const profileIds = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, events, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, events, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );

async function seedProfile(id: string, idents: { anonymous?: string; user?: string } = {}) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

/** A published journey built from the given nodes. */
async function publishJourney(nodes: unknown[]): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, `Journey ${journeyId}`],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [ws, journeyId, JSON.stringify({ purpose: 'marketing_email', nodes }), `hash_${journeyId}`],
  );
  return journeyId;
}

/** Re-entry after exit, so a second application of one event would show up as a second participant. */
const signupJourney = (name: string) =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Signed up', config: { event: name, reentry: 'after_exit' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ]);

/** Trigger, then wait for the same event name: the event that enrolled must not wake its own wait. */
const twiceJourney = (name: string) =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: name }, next: [{ to: 'first' }] },
    { id: 'first', kind: 'waitEvent', label: 'First wait', config: { event: name, timeout: 'P30D' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ]);

const participantsOf = async (journeyId: string) => {
  const { rows } = await d.db.admin.query<{ status: string; matched: boolean; node: string }>(
    'SELECT status, matched, node FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2 ORDER BY id',
    [ws, journeyId],
  );
  return rows;
};

describe('the delivery-age bound stays inside the marker retention (#1027)', () => {
  it('is strictly smaller than the retention, with room for clock skew', () => {
    expect(JOURNEY_EVENT_MAX_AGE_DAYS).toBeLessThan(JOURNEY_EVENT_RETENTION_DAYS);
    expect(() => assertJourneyEventAgeBound()).not.toThrow();
  });

  it('refuses a bound at or beyond the retention, so a drift cannot pass silently', () => {
    expect(() => assertJourneyEventAgeBound(JOURNEY_EVENT_RETENTION_DAYS, JOURNEY_EVENT_RETENTION_DAYS)).toThrow();
    expect(() => assertJourneyEventAgeBound(JOURNEY_EVENT_RETENTION_DAYS + 1, JOURNEY_EVENT_RETENTION_DAYS)).toThrow();
    expect(() => assertJourneyEventAgeBound(0, JOURNEY_EVENT_RETENTION_DAYS)).toThrow();
  });

  it('accepts a receive time inside the bound and refuses one beyond it', () => {
    const now = Date.UTC(2026, 10, 20, 12);
    expect(withinDeliveryAge(new Date(now - DAY_MS).toISOString(), now)).toBe(true);
    expect(withinDeliveryAge(new Date(now - (JOURNEY_EVENT_MAX_AGE_DAYS - 1) * DAY_MS).toISOString(), now)).toBe(true);
    expect(withinDeliveryAge(new Date(now - (JOURNEY_EVENT_MAX_AGE_DAYS + 1) * DAY_MS).toISOString(), now)).toBe(false);
    // A receive time that cannot be read proves nothing about the delivery's age.
    expect(withinDeliveryAge('not a date', now)).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase())('an event past the bound is ignored (#1027)', () => {
  it('does not enrol, does not error, writes no marker and counts the event', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await signupJourney('Stale Signup');
    const receivedAt = new Date(Date.now() - (JOURNEY_EVENT_MAX_AGE_DAYS + 1) * DAY_MS).toISOString();
    const resolved = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Stale Signup', receivedAt })]);

    const before = journeyEventsTooOldCount();
    await expect(journeyHook(d.db, deps())(ws, resolved)).resolves.toBeUndefined();
    const after = journeyEventsTooOldCount();

    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toHaveLength(0);
    // Acked without a marker: the age check refuses the event on every later delivery too.
    const { rows } = await d.db.admin.query('SELECT 1 FROM journey_processed_events WHERE workspace_id = $1', [ws]);
    expect(rows).toHaveLength(0);
    expect(after - before).toBe(1);
  }, 120_000);

  it('does not wake a participant waiting for the same event name', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await twiceJourney('Stale Click');
    const hook = journeyHook(d.db, deps());

    await hook(ws, await runBatch([event({ anonymousId: `anon-${person}`, name: 'Stale Click' })]));
    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'first', matched: false }]);

    // A replay whose receive time is past the bound must not satisfy the wait either.
    const receivedAt = new Date(Date.now() - (JOURNEY_EVENT_MAX_AGE_DAYS + 1) * DAY_MS).toISOString();
    await hook(ws, await runBatch([event({ anonymousId: `anon-${person}`, name: 'Stale Click', receivedAt })]));
    await sweep(d.db, deps());

    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'first', matched: false }]);
  }, 120_000);
});

describe.skipIf(!hasTestDatabase())('an event inside the bound still applies (#1027)', () => {
  it('enrols a fresh event', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await signupJourney('Fresh Signup');

    await journeyHook(d.db, deps())(ws, await runBatch([event({ anonymousId: `anon-${person}`, name: 'Fresh Signup' })]));
    await sweep(d.db, deps());

    expect((await participantsOf(journeyId)).map((row) => row.status)).toEqual(['completed']);
  }, 120_000);

  it('enrols an imported event with a historical timestamp and a fresh receive time', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await signupJourney('Historical Import');
    // An import may carry when something happened long ago; the server's receive time is what makes
    // the delivery young, and it is the only one a sender cannot choose.
    const resolved = await runBatch([
      event({
        anonymousId: `anon-${person}`,
        name: 'Historical Import',
        timestamp: new Date(Date.now() - 400 * DAY_MS).toISOString(),
      }),
    ]);

    await journeyHook(d.db, deps())(ws, resolved);
    await sweep(d.db, deps());

    expect((await participantsOf(journeyId)).map((row) => row.status)).toEqual(['completed']);
  }, 120_000);

  it('still deduplicates a redelivery inside the bound with the marker', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await signupJourney('Signup Again');
    const resolved = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Signup Again' })]);
    const hook = journeyHook(d.db, deps());

    await hook(ws, resolved);
    await sweep(d.db, deps());
    expect((await participantsOf(journeyId)).map((row) => row.status)).toEqual(['completed']);

    await hook(ws, resolved);
    await sweep(d.db, deps());

    expect(await participantsOf(journeyId)).toHaveLength(1);
  }, 120_000);
});
