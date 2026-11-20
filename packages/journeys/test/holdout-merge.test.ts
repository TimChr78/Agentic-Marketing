import { newId } from '@agentic-marketing/core';
import type { EventStore } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { computeJourneyHoldout, holdoutHashVersion, setJourneyHoldoutPageSizeForTests } from '../src/holdout';

// #1070: journeys.holdoutResult must resolve a person's merge family the same way the campaign
// report does (#985). Counting assignment rows counts one person twice when a later entry copied
// an arm onto the survivor, and matching raw outcome ids misses a conversion stored under the id
// the person was merged away from.
//
// #1096: outcomes are read one winners page at a time, scoped to that page's merge family, so the
// report never loads every outcome id for the journey at once.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

const outcomes = { converted: [] as string[], unsubscribed: [] as string[] };
/** The profileIds each event-store call was scoped to, so a test can prove the read is per page. */
const outcomeScopes: (string[] | undefined)[] = [];
const events = {
  async journeyHoldoutOutcomes(_workspaceId: string, q: { profileIds?: string[] }) {
    outcomeScopes.push(q.profileIds);
    const scoped = (ids: string[]) => (q.profileIds ? ids.filter((id) => q.profileIds!.includes(id)) : ids);
    const converted = scoped(outcomes.converted);
    const unsubscribed = scoped(outcomes.unsubscribed);
    return {
      converted,
      unsubscribed,
      convertedAt: converted.map((profileId) => ({ profileId, participantId: null, at: Date.now() })),
      unsubscribedAt: unsubscribed.map((profileId) => ({ profileId, at: Date.now() })),
    };
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_holdout_merge');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const PERCENT = 50;
const HASH = holdoutHashVersion(PERCENT);

async function publishJourney(): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, `Journey ${journeyId}`],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [
      ws,
      journeyId,
      JSON.stringify({
        purpose: 'marketing_email',
        controlGroup: { percent: PERCENT, minSampleSize: 5 },
        nodes: [
          { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Holdout Merge' }, next: [{ to: 'done' }] },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      }),
      `hash_${journeyId}`,
    ],
  );
  return journeyId;
}

async function seedPeople(ids: readonly string[], mergedInto: ReadonlyMap<string, string> = new Map()): Promise<void> {
  await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x`, [ws, ids]);
  if (!mergedInto.size) return;
  await d.db.admin.query(
    `UPDATE profiles p SET merged_into = x.next
     FROM unnest($2::text[], $3::text[]) AS x(id, next)
     WHERE p.workspace_id = $1 AND p.id = x.id`,
    [ws, [...mergedInto.keys()], [...mergedInto.values()]],
  );
}

async function assign(journeyId: string, profileId: string, arm: 'control' | 'treatment', at: Date): Promise<void> {
  await d.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     VALUES ($1, 'journey', $2, $3, $4, $5, $6)`,
    [ws, journeyId, HASH, profileId, arm, at],
  );
}

const result = (journeyId: string, range: { from?: string; to?: string } = {}) =>
  d.db.withWorkspace(ws, (tx) =>
    computeJourneyHoldout(
      {
        tx,
        events,
        workspaceId: ws,
      },
      journeyId,
      range,
    ),
  );

const EARLY = new Date('2026-11-01T00:00:00.000Z');
const LATE = new Date('2026-11-02T00:00:00.000Z');

describe.skipIf(!hasTestDatabase())('journeys.holdoutResult resolves merge families (#1070)', () => {
  it('counts one person once when an arm sits on the alias and on the survivor', async () => {
    outcomes.converted = [];
    outcomes.unsubscribed = [];
    const journeyId = await publishJourney();
    const alias = newId('prf');
    const survivor = newId('prf');
    const otherAlias = newId('prf');
    const otherSurvivor = newId('prf');
    await seedPeople(
      [alias, survivor, otherAlias, otherSurvivor],
      new Map([
        [alias, survivor],
        [otherAlias, otherSurvivor],
      ]),
    );
    // One person: the alias's arm row and the copy a later entry wrote on the survivor.
    await assign(journeyId, alias, 'control', EARLY);
    await assign(journeyId, survivor, 'control', LATE);
    // Another person whose earliest row is treatment, with a later control copy: the earliest wins.
    await assign(journeyId, otherAlias, 'treatment', EARLY);
    await assign(journeyId, otherSurvivor, 'control', LATE);
    const remaining = Array.from({ length: 8 }, () => newId('prf'));
    await seedPeople(remaining);
    for (const id of remaining.slice(0, 4)) await assign(journeyId, id, 'control', EARLY);
    for (const id of remaining.slice(4)) await assign(journeyId, id, 'treatment', EARLY);

    const report = await result(journeyId);

    // Row counting would say 7 control and 5 treatment (one person twice in each family).
    expect(report.control.entered).toBe(5);
    expect(report.treatment.entered).toBe(5);
    expect(report.suppressed).toBe(false);
  }, 120_000);

  it('counts a conversion stored under the merged-away id', async () => {
    outcomes.converted = [];
    outcomes.unsubscribed = [];
    const journeyId = await publishJourney();
    const alias = newId('prf');
    const survivor = newId('prf');
    await seedPeople([alias, survivor], new Map([[alias, survivor]]));
    // The assignment was recorded on the survivor; the conversion happened before the merge and
    // still carries the alias id in ClickHouse.
    await assign(journeyId, survivor, 'control', EARLY);
    const others = Array.from({ length: 9 }, () => newId('prf'));
    await seedPeople(others);
    for (const id of others.slice(0, 4)) await assign(journeyId, id, 'control', EARLY);
    for (const id of others.slice(4)) await assign(journeyId, id, 'treatment', EARLY);
    outcomes.converted = [alias];

    const report = await result(journeyId);

    expect(report.control.entered).toBe(5);
    expect(report.control.converted).toBe(1);
    expect(report.treatment.converted).toBe(0);
  }, 120_000);

  it('reads outcomes one winners page at a time, scoped to that page (#1096)', async () => {
    outcomes.converted = [];
    outcomes.unsubscribed = [];
    const journeyId = await publishJourney();
    const ids = Array.from({ length: 12 }, () => newId('prf'));
    await seedPeople(ids);
    for (const id of ids.slice(0, 6)) await assign(journeyId, id, 'control', EARLY);
    for (const id of ids.slice(6)) await assign(journeyId, id, 'treatment', EARLY);
    // Every person converts, so both pages have an outcome to count.
    outcomes.converted = [...ids];
    outcomeScopes.length = 0;

    let report: Awaited<ReturnType<typeof result>>;
    setJourneyHoldoutPageSizeForTests(5);
    try {
      report = await result(journeyId);
    } finally {
      setJourneyHoldoutPageSizeForTests(null);
    }

    // 12 winners in pages of 5 give three reads (5, 5, 2); each carries only that page's family.
    expect(outcomeScopes).toHaveLength(3);
    for (const scope of outcomeScopes) {
      expect(scope).toBeDefined();
      expect(scope!.length).toBeLessThanOrEqual(5);
    }
    // The per-page reads still add up to the whole report.
    expect(report.control.entered).toBe(6);
    expect(report.control.converted).toBe(6);
    expect(report.treatment.converted).toBe(6);
  }, 120_000);
});
