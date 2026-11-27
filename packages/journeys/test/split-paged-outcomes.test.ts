import { newId } from '@agentic-marketing/core';
import type { EventStore } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { computeJourneySplit, setJourneySplitPageSizeForTests } from '../src/splitReport';

// Every merge-family resolution the report makes, with how many ids it returned: a page that
// resolved for the whole journey would show one call with every family id (#1105 review).
const scopeCalls = vi.hoisted(() => [] as { people: number; familyIds: number }[]);
vi.mock('../src/holdout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/holdout')>();
  return {
    ...actual,
    pageOutcomeScope: async (...args: Parameters<typeof actual.pageOutcomeScope>) => {
      const scope = await actual.pageOutcomeScope(...args);
      scopeCalls.push({ people: args[2].length, familyIds: scope.profileIds.length });
      return scope;
    },
  };
});

// #1105: journeys.splitResult used to read every converted and unsubscribed id for the journey
// before attributing them. The split now reads its outcomes one page of participants at a time,
// scoped to that page's merge family, the way journeys.holdoutResult does (#1096). The per-page
// scopes are what the fake store records, so a test can prove the read is bounded and still adds
// up to the same counts the whole-journey read produced.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

interface EntryRow {
  participantId: number;
  profileId: string;
  arm: number;
  at: number;
}

let entries: EntryRow[] = [];
let converted: { profileId: string; participantId: number | null; at: number }[] = [];
let unsubscribed: { profileId: string; at: number }[] = [];
/** The profileIds each event-store call was scoped to, so a test can prove the read is per page. */
const outcomeScopes: (string[] | undefined)[] = [];
/** The size of each split-arms page the report asked for, so a test can prove the read is paged. */
const armPages: number[] = [];

/** A row queued when the first ClickHouse read runs, i.e. between the report's two barrier reads. */
let queueOnFirstRead: { journeyId: string; at: string } | null = null;

const events = {
  async journeySplitArms(_workspaceId: string, q: { pageSize?: number; onPage?: (rows: EntryRow[]) => void | Promise<void> }) {
    if (queueOnFirstRead) {
      const queued = queueOnFirstRead;
      queueOnFirstRead = null;
      await d.db.admin.query(
        `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, subject_ref, state)
         VALUES ($1, $2, 'journey_event', $3, $4, $5, 'pending')`,
        [
          ws,
          newId('obx'),
          { events: [{ journeyId: queued.journeyId, at: queued.at }] },
          `journey-event:race:${newId('obx')}`,
          queued.journeyId,
        ],
      );
    }
    // Answer the report the way the ClickHouse store does: bounded pages when it supplies an
    // `onPage` consumer, the whole list for the historical unbounded call (#1108).
    if (!q.onPage) return entries;
    const size = Math.max(1, Math.trunc(q.pageSize ?? 10_000));
    for (let at = 0; at < entries.length; at += size) {
      const page = entries.slice(at, at + size);
      armPages.push(page.length);
      await q.onPage(page);
    }
    return [];
  },
  async journeyHoldoutOutcomes(_workspaceId: string, q: { profileIds?: string[] }) {
    outcomeScopes.push(q.profileIds);
    const scoped = (id: string) => q.profileIds === undefined || q.profileIds.includes(id);
    const c = converted.filter((row) => scoped(row.profileId));
    const u = unsubscribed.filter((row) => scoped(row.profileId));
    return {
      converted: [...new Set(c.map((row) => row.profileId))],
      unsubscribed: [...new Set(u.map((row) => row.profileId))],
      convertedAt: c,
      unsubscribedAt: u,
    };
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_split_paged');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

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
        nodes: [
          { id: 'trigger', kind: 'trigger', label: 'Start', config: { event: 'Split Paged' }, next: [{ to: 'split' }] },
          { id: 'split', kind: 'split', label: 'A/B', config: { weights: [50, 50] }, next: [{ to: 'a' }, { to: 'b' }] },
          { id: 'a', kind: 'exit', label: 'A', config: {} },
          { id: 'b', kind: 'exit', label: 'B', config: {} },
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

function reset(rows: EntryRow[]): void {
  entries = rows;
  converted = [];
  unsubscribed = [];
  outcomeScopes.length = 0;
  armPages.length = 0;
}

const splitResult = (journeyId: string, limits: { pageProfileLimit?: number } = {}, range: { from?: string; to?: string } = {}) =>
  d.db.withWorkspace(ws, (tx) =>
    computeJourneySplit({ tx, events, workspaceId: ws, ...limits }, { journeyId, node: 'split', minSampleSize: 1, ...range }),
  );

const BASE = Date.parse('2026-11-01T00:00:00.000Z');
const at = (offset: number) => BASE + offset;

describe.skipIf(!hasTestDatabase())('journeys.splitResult reads its outcomes one page at a time (#1105)', () => {
  it('resolves each page’s merge family for that page only, not for the journey', async () => {
    const journeyId = await publishJourney();
    // Four people with one merged-away id each: eight profiles, two per person.
    const survivors = Array.from({ length: 4 }, () => newId('prf'));
    const aliases = survivors.map(() => newId('prf'));
    await seedPeople(survivors);
    await seedPeople(aliases, new Map(aliases.map((id, i) => [id, survivors[i]!])));
    reset([
      ...survivors.map((id, i) => ({ participantId: 100 + i, profileId: id, arm: i % 2, at: at(i) })),
      ...aliases.map((id, i) => ({ participantId: 200 + i, profileId: id, arm: i % 2, at: at(i + 100) })),
    ]);

    scopeCalls.length = 0;
    setJourneySplitPageSizeForTests(2);
    try {
      await splitResult(journeyId);
    } finally {
      setJourneySplitPageSizeForTests(null);
    }

    // Eight participants in pages of two resolve in four calls, then the four people in pages of
    // two give two more. A single journey-wide resolution would be one call with eight ids.
    expect(scopeCalls).toHaveLength(6);
    for (const call of scopeCalls) {
      expect(call.people).toBeLessThanOrEqual(2);
      // Each call resolves the two families of its page (four ids), never all eight.
      expect(call.familyIds).toBeLessThanOrEqual(4);
    }
  }, 120_000);

  it('scopes every outcome read to one page of participants and keeps the counts', async () => {
    const journeyId = await publishJourney();
    const ids = Array.from({ length: 12 }, () => newId('prf'));
    await seedPeople(ids);
    reset(ids.map((id, i) => ({ participantId: 500 + i, profileId: id, arm: i % 2, at: at(i) })));
    // Every second person converted; two of them also unsubscribed.
    converted = ids.map((profileId, i) => ({ profileId, participantId: 500 + i, at: at(i + 100) })).filter((_, i) => i % 2 === 0);
    unsubscribed = ids.slice(0, 2).map((profileId, i) => ({ profileId, at: at(i + 200) }));

    let report: Awaited<ReturnType<typeof splitResult>>;
    setJourneySplitPageSizeForTests(5);
    try {
      report = await splitResult(journeyId);
    } finally {
      setJourneySplitPageSizeForTests(null);
    }

    // 12 participants in pages of 5 give three reads (5, 5, 2), each scoped to its own page.
    expect(outcomeScopes).toHaveLength(3);
    for (const scope of outcomeScopes) {
      expect(scope).toBeDefined();
      expect(scope!.length).toBeLessThanOrEqual(5);
    }
    // The per-page reads still add up to the whole result.
    expect(report.suppressed).toBe(false);
    expect(report.arms.map((arm) => [arm.entered, arm.converted, arm.unsubscribed])).toEqual([
      [6, 6, 1],
      [6, 0, 1],
    ]);
    expect(report.note).not.toContain('merge-family');
  }, 120_000);

  it('reads the split arms one page at a time and keeps the counts (#1108)', async () => {
    const journeyId = await publishJourney();
    const ids = Array.from({ length: 12 }, () => newId('prf'));
    await seedPeople(ids);
    reset(ids.map((id, i) => ({ participantId: 700 + i, profileId: id, arm: i % 2, at: at(i) })));
    converted = ids.map((profileId, i) => ({ profileId, participantId: 700 + i, at: at(i + 100) })).filter((_, i) => i % 2 === 0);
    unsubscribed = ids.slice(0, 2).map((profileId, i) => ({ profileId, at: at(i + 200) }));

    let report: Awaited<ReturnType<typeof splitResult>>;
    setJourneySplitPageSizeForTests(5);
    try {
      report = await splitResult(journeyId);
    } finally {
      setJourneySplitPageSizeForTests(null);
    }

    // Twelve split takes in pages of five: three reads (5, 5, 2), never the whole list at once.
    expect(armPages).toEqual([5, 5, 2]);
    // Paging the read does not change the counts.
    expect(report.suppressed).toBe(false);
    expect(report.arms.map((arm) => [arm.entered, arm.converted, arm.unsubscribed])).toEqual([
      [6, 6, 1],
      [6, 0, 1],
    ]);
  }, 120_000);

  it('counts an outcome stored under a merged-away id for its person', async () => {
    const journeyId = await publishJourney();
    const alias = newId('prf');
    const survivor = newId('prf');
    await seedPeople([alias, survivor], new Map([[alias, survivor]]));
    const others = Array.from({ length: 9 }, () => newId('prf'));
    await seedPeople(others);
    reset([
      { participantId: 1, profileId: survivor, arm: 0, at: at(0) },
      ...others.map((id, i) => ({ participantId: 10 + i, profileId: id, arm: i < 4 ? 0 : 1, at: at(i + 1) })),
    ]);
    // The split step and the conversion were recorded on the survivor; the unsubscribe happened
    // before the merge and still carries the alias id.
    converted = [{ profileId: survivor, participantId: 1, at: at(50) }];
    unsubscribed = [{ profileId: alias, at: at(60) }];

    const report = await splitResult(journeyId);

    expect(report.arms.map((arm) => [arm.entered, arm.converted, arm.unsubscribed])).toEqual([
      [5, 1, 1],
      [5, 0, 0],
    ]);
  }, 120_000);

  it('keeps a re-entrant’s outcome off a second arm when the page boundary splits nothing of the person', async () => {
    const journeyId = await publishJourney();
    const reentrant = newId('prf');
    const others = Array.from({ length: 10 }, () => newId('prf'));
    await seedPeople([reentrant, ...others]);
    // Two entries for one person, one per arm; a page size of one still keeps them together,
    // because pages are groups of people and never split one person's entries.
    reset([
      { participantId: 1, profileId: reentrant, arm: 0, at: at(0) },
      { participantId: 2, profileId: reentrant, arm: 1, at: at(1_000) },
      ...others.map((id, i) => ({ participantId: 10 + i, profileId: id, arm: i % 2, at: at(i + 1) })),
    ]);
    // No participant: the latest entry at or before the outcome decides, which is participant 2.
    unsubscribed = [{ profileId: reentrant, at: at(2_000) }];

    let report: Awaited<ReturnType<typeof splitResult>>;
    setJourneySplitPageSizeForTests(1);
    try {
      report = await splitResult(journeyId);
    } finally {
      setJourneySplitPageSizeForTests(null);
    }

    expect(report.arms.map((arm) => arm.unsubscribed)).toEqual([0, 1]);
    // Eleven people, one page each: the person with two entries is still one read.
    expect(outcomeScopes).toHaveLength(11);
  }, 120_000);

  it('matches stored profile ids only when a page is over its profile bound, and says so', async () => {
    const journeyId = await publishJourney();
    const control = newId('prf');
    const otherControl = Array.from({ length: 4 }, () => newId('prf'));
    const treatment = Array.from({ length: 5 }, () => newId('prf'));
    // Four aliases merged into one control person: five profiles for that participant.
    const aliases = Array.from({ length: 4 }, () => newId('prf'));
    await seedPeople([control, ...otherControl]);
    await seedPeople(aliases, new Map(aliases.map((id) => [id, control])));
    await seedPeople(treatment);
    reset([
      { participantId: 1, profileId: control, arm: 0, at: at(0) },
      ...otherControl.map((id, i) => ({ participantId: 10 + i, profileId: id, arm: 0, at: at(i + 1) })),
      ...treatment.map((id, i) => ({ participantId: 20 + i, profileId: id, arm: 1, at: at(i + 1) })),
    ]);
    // One outcome on the person, one on an alias that only the family map could resolve.
    unsubscribed = [
      { profileId: control, at: at(500) },
      { profileId: aliases[0]!, at: at(600) },
    ];

    const report = await splitResult(journeyId, { pageProfileLimit: 3 });

    // The alias outcome cannot be attributed without the map, so only the stored id counts.
    expect(report.arms[0]).toMatchObject({ converted: 0, unsubscribed: 1 });
    expect(report.note).toContain('more than 3 merge-family profiles to resolve');
    expect(report.note).not.toContain('merges deep');
  }, 120_000);

  it('names a corruptly deep merge family instead of a profile count', async () => {
    const journeyId = await publishJourney();
    // One family 257 merges deep: the component walk stops at MERGE_MAX_HOPS (256).
    const family = Array.from({ length: 258 }, () => newId('prf'));
    await seedPeople(family, new Map(family.slice(0, -1).map((id, i) => [id, family[i + 1]!])));
    const control = family[family.length - 1]!;
    const otherControl = Array.from({ length: 4 }, () => newId('prf'));
    const treatment = Array.from({ length: 5 }, () => newId('prf'));
    await seedPeople([...otherControl, ...treatment]);
    reset([
      { participantId: 1, profileId: control, arm: 0, at: at(0) },
      ...otherControl.map((id, i) => ({ participantId: 10 + i, profileId: id, arm: 0, at: at(i + 1) })),
      ...treatment.map((id, i) => ({ participantId: 20 + i, profileId: id, arm: 1, at: at(i + 1) })),
    ]);
    unsubscribed = [
      { profileId: control, at: at(500) },
      { profileId: family[0]!, at: at(600) },
    ];

    const report = await splitResult(journeyId);

    expect(report.arms[0]).toMatchObject({ unsubscribed: 1 });
    expect(report.note).toContain('256 or more merges deep');
    expect(report.note).not.toContain('more than');
  }, 120_000);

  it('withholds an actionable verdict while the journey events are still queued (#1244 review)', async () => {
    const journeyId = await publishJourney();
    const ids = Array.from({ length: 12 }, () => newId('prf'));
    await seedPeople(ids);
    reset(ids.map((id, i) => ({ participantId: 900 + i, profileId: id, arm: i % 2, at: at(i) })));
    converted = ids.map((profileId, i) => ({ profileId, participantId: 900 + i, at: at(i + 100) })).filter((_, i) => i % 2 === 0);

    const complete = await splitResult(journeyId);
    expect(complete.comparisons.map((c) => c.verdict)).toEqual(['treatment_worse']);

    // The sweep queued this journey's step events in the outbox; ClickHouse has not seen them yet.
    const outboxId = newId('obx');
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, subject_ref, state)
       VALUES ($1, $2, 'journey_event', '{"events":[]}'::jsonb, $3, $4, 'pending')`,
      [ws, outboxId, `journey-event:test:${journeyId}`, journeyId],
    );
    try {
      const report = await splitResult(journeyId);
      expect(report.comparisons).toEqual([]);
      expect(report.note).toContain("Publication of this journey's journey events is incomplete");
      expect(report.note).toContain('1 pending');
    } finally {
      await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1 AND id = $2', [ws, outboxId]);
    }
  }, 120_000);

  it('withholds the verdict when a conversion is queued between the snapshot and the reads (#1269 review)', async () => {
    const journeyId = await publishJourney();
    const ids = Array.from({ length: 12 }, () => newId('prf'));
    await seedPeople(ids);
    reset(ids.map((id, i) => ({ participantId: 900 + i, profileId: id, arm: i % 2, at: at(i) })));
    // Only the treatment arm converts: a clear winner if the queued control conversion is missed.
    converted = ids.map((profileId, i) => ({ profileId, participantId: 900 + i, at: at(i + 100) })).filter((_, i) => i % 2 === 1);
    queueOnFirstRead = { journeyId, at: new Date().toISOString() };
    try {
      // The command path: the report runs in a REPEATABLE READ snapshot, which cannot see the row
      // queued above; the second barrier read uses the pool's own transaction (#1269 review).
      const report = await d.db.withWorkspace(
        ws,
        (tx) => computeJourneySplit({ tx, db: d.db, events, workspaceId: ws }, { journeyId, node: 'split', minSampleSize: 1 }),
        { snapshot: true },
      );
      expect(report.comparisons).toEqual([]);
      expect(report.note).toContain("Publication of this journey's journey events is incomplete");
      expect(report.note).toContain('1 pending');
    } finally {
      queueOnFirstRead = null;
      await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1 AND subject_ref = $2', [ws, journeyId]);
    }
  }, 120_000);
});

describe.skipIf(!hasTestDatabase())('the split’s k floor counts people (#1105 review)', () => {
  it('counts a merged person once, so an arm of five entries and four people is hidden', async () => {
    const journeyId = await publishJourney();
    const survivor = newId('prf');
    const alias = newId('prf');
    const others = Array.from({ length: 3 }, () => newId('prf'));
    await seedPeople([survivor, ...others]);
    await seedPeople([alias], new Map([[alias, survivor]]));
    const treatment = Array.from({ length: 5 }, () => newId('prf'));
    await seedPeople(treatment);
    reset([
      // One person with two entries in arm 0, plus three other people: four people, five entries.
      { participantId: 1, profileId: survivor, arm: 0, at: at(0) },
      { participantId: 2, profileId: alias, arm: 0, at: at(1) },
      ...others.map((id, i) => ({ participantId: 10 + i, profileId: id, arm: 0, at: at(i + 2) })),
      ...treatment.map((id, i) => ({ participantId: 20 + i, profileId: id, arm: 1, at: at(i + 2) })),
    ]);

    const report = await splitResult(journeyId);

    expect(report.suppressed).toBe(true);
    // Five entries would have cleared k=5; four people do not.
    expect(report.arms[0]).toMatchObject({ entered: null, converted: null, suppressed: true });
    expect(report.arms[1]).toMatchObject({ entered: 5, suppressed: false });
    expect(report.comparisons).toEqual([]);
  }, 120_000);
});
