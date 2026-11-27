import { randomBytes } from 'node:crypto';
import { analyseHoldout, anyArmBelowK, artifactTypes, K } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq, sql } from 'drizzle-orm';
import {
  incompletePublicationNote,
  JOURNEY_HOLDOUT_PAGE_PROFILE_LIMIT,
  outsideWindowFailedNote,
  type PageUnresolved,
  pageOutcomeScope,
  publicationChangedNote,
  readPublicationBarrier,
  unresolvedOutcomeNote,
} from './holdout';
import { attributeSplitOutcomes, type SplitCounts, type SplitEntry } from './split';

// journeys.splitResult (#313), split out of the command so the paging can be tested against a
// fake event store (#1105). Each outcome is attributed to exactly one split entry; the rule
// itself is in split.ts.

const DEFAULT_JOURNEY_SPLIT_PAGE_SIZE = 1_000;

/** The split's participant page size; tests override it, production keeps the default (never env). */
let journeySplitPageSize = DEFAULT_JOURNEY_SPLIT_PAGE_SIZE;

/**
 * Test-only override for the split report's participant page size (#1105). Like the holdout's, the
 * value is an internal bound rather than configuration; a test sets it to cross a page boundary
 * without a large fixture and passes null to restore the default.
 */
export function setJourneySplitPageSizeForTests(size: number | null): void {
  journeySplitPageSize = size === null ? DEFAULT_JOURNEY_SPLIT_PAGE_SIZE : Math.max(1, Math.trunc(size));
}

export interface JourneySplitArm {
  arm: number;
  weight: number;
  entered: number | null;
  converted: number | null;
  unsubscribed: number | null;
  conversionRate: number | null;
  unsubscribeRate: number | null;
  suppressed: boolean;
}

export interface JourneySplitComparison {
  arm: number;
  versus: 0;
  absoluteLift: number;
  relativeLift: number | null;
  ci95: [number, number] | null;
  minSampleSizeMet: boolean;
  verdict: 'not_enough_data' | 'no_clear_difference' | 'treatment_better' | 'treatment_worse';
}

export interface JourneySplitResult {
  journeyId: string;
  node: string;
  /** The k-anonymity floor the arms were measured against. */
  k: number;
  suppressed: boolean;
  arms: JourneySplitArm[];
  comparisons: JourneySplitComparison[];
  note: string;
}

export interface JourneySplitInput {
  journeyId: string;
  node: string;
  from?: string;
  to?: string;
  minSampleSize: number;
}

/**
 * The computation behind journeys.splitResult.
 *
 * A journey can have a large split and outcome history, so the split reads its takes and its
 * outcomes one page of participants at a time, scoped to that page's merge family, the way the
 * holdout report does (#1096, #1105, #1108). A page is a group of people and never splits one
 * person's entries, so an outcome is read in exactly one page and each arm's counts stay the whole
 * journey's counts.
 */
export async function computeJourneySplit(
  deps: {
    tx: Tx;
    /** The pool, when the caller has it: the second barrier read then gets its own transaction. */
    db?: Db;
    events: EventStore;
    workspaceId: string;
    /**
     * The most profiles one page may expand to when resolving outcomes (#1105). Internal, never
     * environment configuration; tests inject a small value to exercise the guard.
     */
    pageProfileLimit?: number;
  },
  input: JourneySplitInput,
): Promise<JourneySplitResult> {
  const [a] = await deps.tx
    .select({ publishedVersion: schema.artifacts.publishedVersion, type: schema.artifacts.type })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.journeyId));
  if (a?.type !== 'journey') throw new AppError('not_found', `No journey ${input.journeyId}.`);
  if (!a.publishedVersion) throw new AppError('not_found', `Journey ${input.journeyId} has no published version.`);
  const [v] = await deps.tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, input.journeyId), eq(schema.artifactVersions.number, a.publishedVersion)));
  const def = artifactTypes.journey.content.parse(v?.content);
  const split = def.nodes.find((n) => n.id === input.node);
  if (split?.kind !== 'split') throw new AppError('invalid_input', `Node ${input.node} is not a split in the published journey.`);
  const weights = (split.config as { weights?: number[] }).weights ?? [];
  const from = input.from ? new Date(input.from) : undefined;
  const to = input.to ? new Date(input.to) : undefined;
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const ws = deps.workspaceId;
  const pageProfileLimit = deps.pageProfileLimit ?? JOURNEY_HOLDOUT_PAGE_PROFILE_LIMIT;
  const unresolved = new Set<PageUnresolved>();
  // Snapshot the outbox before the ClickHouse reads: an event still queued here is not in what
  // follows, and one published afterwards must not make this report look complete. A verdict is
  // actionable (the lifecycle optimiser promotes or retires an arm), so it waits for publication.
  // Read it again after the reads, because a conversion queued between the snapshot and the reads is
  // in neither; the revision catches one queued and published in between (#1269 review).
  const window = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const publicationBefore = await readPublicationBarrier(deps, input.journeyId, { window, revision: true });
  const beforeIncomplete = publicationBefore.outstanding > 0 || publicationBefore.failed > 0;

  // The split's takes land in a transaction-scoped temporary table, the way the holdout's winners
  // do (#1108). The ClickHouse read is a bounded keyset page and the report then pages the takes by
  // person, so the API process holds a page, not the journey's whole split history.
  const table = `split_arms_${randomBytes(6).toString('hex')}`;
  const temp = sql.raw(table);
  await deps.tx.execute(sql`
    CREATE TEMP TABLE ${temp} (
      participant_id bigint PRIMARY KEY,
      profile_id text NOT NULL,
      person text,
      arm integer NOT NULL,
      at_ms bigint NOT NULL
    ) ON COMMIT DROP`);
  // Both keyset walks below read this table a page at a time, and the id update must not scan it.
  await deps.tx.execute(sql`CREATE INDEX ON ${temp} (profile_id)`);
  await deps.tx.execute(sql`CREATE INDEX ON ${temp} (person)`);
  let takeCount = 0;
  await deps.events.journeySplitArms(ws, {
    journeyId: input.journeyId,
    node: input.node,
    ...range,
    pageSize: journeySplitPageSize,
    onPage: async (page) => {
      if (!page.length) return;
      takeCount += page.length;
      await deps.tx.execute(sql`
        INSERT INTO ${temp} (participant_id, profile_id, arm, at_ms)
        VALUES ${sql.join(
          page.map((entry) => sql`(${entry.participantId}, ${entry.profileId}, ${entry.arm}, ${entry.at})`),
          sql`, `,
        )}
        ON CONFLICT (participant_id) DO NOTHING`);
    },
  });

  // Resolve the stored ids to their person one page of distinct ids at a time. A split entry may
  // carry an id the person was later merged away from, so the raw id is resolved before it is
  // grouped; a page over the family guard keeps its stored ids (#1096, #1105).
  let afterProfile: string | undefined;
  for (;;) {
    const { rows } = await deps.tx.execute<{ profile_id: string }>(sql`
      SELECT DISTINCT profile_id FROM ${temp}
      ${afterProfile === undefined ? sql`` : sql`WHERE profile_id > ${afterProfile}`}
      ORDER BY profile_id LIMIT ${journeySplitPageSize}`);
    if (!rows.length) break;
    const ids = rows.map((row) => row.profile_id);
    afterProfile = ids[ids.length - 1];
    const scope = await pageOutcomeScope(deps.tx, ws, ids, pageProfileLimit);
    if (scope.unresolved) unresolved.add(scope.unresolved);
    // Each id's own resolution decides its person, so an over-limit page keeps its stored id and
    // cannot leak a family resolution into another page.
    const persons = ids.map((id) => scope.byProfile.get(id) ?? id);
    await deps.tx.execute(sql`
      UPDATE ${temp} t SET person = v.person
      FROM (
        SELECT unnest(${sql.param(ids)}::text[]) AS profile_id,
               unnest(${sql.param(persons)}::text[]) AS person
      ) v
      WHERE t.profile_id = v.profile_id`);
    if (rows.length < journeySplitPageSize) break;
  }
  await deps.tx.execute(sql`UPDATE ${temp} SET person = profile_id WHERE person IS NULL`);

  // Entrants and the k floor's distinct people stay in SQL: one person re-entering an arm five
  // times is still one person, and a person whose two ids were merged is one person too (#1105).
  const summary = await deps.tx.execute<{ arm: number; entered: number; people: number }>(sql`
    SELECT arm, count(*)::int AS entered, count(DISTINCT person)::int AS people
    FROM ${temp}
    WHERE arm >= 0 AND arm < ${weights.length}
    GROUP BY arm`);
  const counts: SplitCounts[] = Array.from({ length: weights.length }, () => ({ entered: 0, converted: 0, unsubscribed: 0 }));
  const armPeople: number[] = Array.from({ length: weights.length }, () => 0);
  for (const row of summary.rows) {
    const arm = Number(row.arm);
    if (arm < 0 || arm >= weights.length) continue;
    counts[arm]!.entered = Number(row.entered);
    armPeople[arm] = Number(row.people);
  }

  // Attribute outcomes one page of people at a time. A page is a group of people and never splits
  // one person's entries, so an outcome is read in exactly one page and each arm's counts stay the
  // whole journey's counts (#1096, #1105, #1108).
  let afterPerson: string | undefined;
  for (;;) {
    const { rows } = await deps.tx.execute<{ person: string }>(sql`
      SELECT DISTINCT person FROM ${temp}
      ${afterPerson === undefined ? sql`` : sql`WHERE person > ${afterPerson}`}
      ORDER BY person LIMIT ${journeySplitPageSize}`);
    if (!rows.length) break;
    const people = rows.map((row) => row.person);
    afterPerson = people[people.length - 1];
    const entryRows = await deps.tx.execute<{ participant_id: string; person: string; arm: number; at_ms: string }>(sql`
      SELECT participant_id::text AS participant_id, person, arm, at_ms::text AS at_ms
      FROM ${temp}
      WHERE person = ANY(${sql.param(people)}::text[]) AND arm >= 0 AND arm < ${weights.length}`);
    const entries: SplitEntry[] = entryRows.rows.map((row) => ({
      participantId: Number(row.participant_id),
      profileId: row.person,
      arm: Number(row.arm),
      at: Number(row.at_ms),
    }));
    // The family is resolved for this page of people only and dropped with it, as the holdout
    // report does (#1096, #1105).
    const scope = await pageOutcomeScope(deps.tx, ws, people, pageProfileLimit);
    if (scope.unresolved) unresolved.add(scope.unresolved);
    const outcomes = await deps.events.journeyHoldoutOutcomes(ws, {
      journeyId: input.journeyId,
      ...range,
      profileIds: scope.profileIds,
    });
    // A page that resolved reads its whole family, so an outcome stored under a merged-away id
    // still lands on the person's entry. Over the guard the page is read by stored id only.
    const outcomePerson = (id: string) => scope.byProfile.get(id) ?? id;
    const pageCounts = attributeSplitOutcomes(
      entries,
      {
        converted: outcomes.convertedAt.map((outcome) => ({
          profileId: outcomePerson(outcome.profileId),
          participantId: outcome.participantId,
          at: outcome.at,
        })),
        unsubscribed: outcomes.unsubscribedAt.map((outcome) => ({ profileId: outcomePerson(outcome.profileId), at: outcome.at })),
      },
      weights.length,
    );
    // Every entry belongs to exactly one page, so the pages' counts add up. `entered` comes from
    // the SQL aggregate above; only outcomes are attributed here.
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i]!;
      count.converted += pageCounts[i]?.converted ?? 0;
      count.unsubscribed += pageCounts[i]?.unsubscribed ?? 0;
    }
    if (rows.length < journeySplitPageSize) break;
  }

  const publicationAfter = await readPublicationBarrier(
    deps,
    input.journeyId,
    {
      window,
      ...(publicationBefore.revision ? { since: new Date(publicationBefore.revision) } : {}),
    },
    true,
  );
  const afterIncomplete = publicationAfter.outstanding > 0 || publicationAfter.failed > 0;
  const publicationChanged = publicationAfter.changedSince === true;
  const publicationIncomplete = beforeIncomplete || afterIncomplete || publicationChanged;
  // The counts are existence flags per snapshot; the largest one is what the note can honestly say.
  const publication = {
    outstanding: Math.max(publicationBefore.outstanding, publicationAfter.outstanding),
    failed: Math.max(publicationBefore.failed, publicationAfter.failed),
  };

  const rate = (n: number, of: number) => (of ? n / of : 0);
  // The same k floor the holdout read applies, per arm (#757): an arm below k never reports a
  // count or rate, and no comparison or verdict is computed from a hidden baseline. The floor
  // counts distinct people, not entries, after their ids resolve to their person (#1105 review).
  const belowK = anyArmBelowK(armPeople.map((n) => ({ entered: n })));
  const arms = counts.map((c, i) =>
    belowK && armPeople[i]! < K
      ? {
          arm: i,
          weight: weights[i],
          entered: null,
          converted: null,
          unsubscribed: null,
          conversionRate: null,
          unsubscribeRate: null,
          suppressed: true,
        }
      : {
          arm: i,
          weight: weights[i],
          ...c,
          conversionRate: rate(c.converted, c.entered),
          unsubscribeRate: rate(c.unsubscribed, c.entered),
          suppressed: false,
        },
  );
  const comparisons: JourneySplitComparison[] =
    belowK || publicationIncomplete
      ? []
      : counts.slice(1).map((c, i) => {
          const r = analyseHoldout(counts[0]!, c, input.minSampleSize);
          return {
            arm: i + 1,
            versus: 0 as const,
            absoluteLift: r.absoluteLift,
            relativeLift: r.relativeLift,
            ci95: r.ci95,
            minSampleSizeMet: r.minSampleSizeMet,
            verdict: r.verdict,
          };
        });
  const better = comparisons.filter((c) => c.verdict === 'treatment_better').map((c) => `arm ${c.arm}`);
  const baseNote = publicationIncomplete
    ? beforeIncomplete || afterIncomplete
      ? `${incompletePublicationNote(publication, 'every comparison is withheld')}${belowK ? ` An arm has fewer than k=${K} people, so its counts and rates are withheld.` : ''}`
      : publicationChangedNote('every comparison is withheld')
    : !takeCount
      ? 'Nobody has reached this split yet.'
      : belowK
        ? `An arm has fewer than k=${K} people, so its counts and rates and every comparison are withheld.`
        : better.length
          ? `${better.join(', ')} converts better than arm 0 with a 95% interval above zero.`
          : comparisons.every((c) => c.verdict === 'not_enough_data')
            ? `Not enough people yet: each arm needs ${input.minSampleSize}.`
            : 'No arm is clearly better than arm 0 yet.';
  const windowNote = publicationBefore.outsideWindowFailed || publicationAfter.outsideWindowFailed ? ` ${outsideWindowFailedNote()}` : '';
  const note = `${unresolved.size === 0 ? baseNote : `${baseNote} ${[...unresolved].map((reason) => unresolvedOutcomeNote(reason, pageProfileLimit)).join(' ')}`}${windowNote}`;
  return { journeyId: input.journeyId, node: input.node, k: K, suppressed: belowK, arms, comparisons, note };
}
