import { analyseHoldout, anyArmBelowK, artifactTypes, K } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { and, eq } from 'drizzle-orm';
import { JOURNEY_HOLDOUT_PAGE_PROFILE_LIMIT, type PageUnresolved, pageOutcomeScope, unresolvedOutcomeNote } from './holdout';
import { attributeSplitOutcomes, type SplitCounts, type SplitEntry, splitArmPeople } from './split';

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

/** Chunks a list into pages without copying the whole list again. */
function* pages<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let at = 0; at < items.length; at += size) yield items.slice(at, at + size);
}

/**
 * The computation behind journeys.splitResult.
 *
 * A journey can have a large outcome history, so the split reads its outcomes one page of
 * participants at a time, scoped to that page's merge family, the way the holdout report does
 * (#1096, #1105). A page is a group of people and never splits one person's entries, so an
 * outcome is read in exactly one page and each arm's counts stay the whole journey's counts.
 */
export async function computeJourneySplit(
  deps: {
    tx: Tx;
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
  const taken = await deps.events.journeySplitArms(ws, { journeyId: input.journeyId, node: input.node, ...range });
  const counts: SplitCounts[] = Array.from({ length: weights.length }, () => ({ entered: 0, converted: 0, unsubscribed: 0 }));
  const pageProfileLimit = deps.pageProfileLimit ?? JOURNEY_HOLDOUT_PAGE_PROFILE_LIMIT;
  const unresolved = new Set<PageUnresolved>();

  // Resolve the participants to their person once, a page at a time. A split entry may carry an id
  // the person was later merged away from, so the raw id is resolved before it is grouped. Only
  // the participant ids are kept (O(participants)); a merge family is resolved again for each
  // outcome page and dropped with it, so memory stays a page rather than every family (#1105).
  const personOf = new Map<string, string>();
  const personKey = (id: string) => personOf.get(id) ?? id;
  const participants = [...new Set(taken.map((entry) => entry.profileId))];
  for (const page of pages(participants, journeySplitPageSize)) {
    const scope = await pageOutcomeScope(deps.tx, ws, page, pageProfileLimit);
    if (scope.unresolved) unresolved.add(scope.unresolved);
    // An unresolved page (or an unknown profile) keeps the stored id, so the report matches on it.
    for (const id of page) personOf.set(id, scope.byProfile.get(id) ?? id);
  }

  // Group the entries by person, so one person's re-entries stay in one page and the
  // "latest entry at or before the outcome" rule sees the same entries it always did.
  const groups = new Map<string, SplitEntry[]>();
  for (const entry of taken) {
    const person = personKey(entry.profileId);
    const group = groups.get(person);
    const normalized = { ...entry, profileId: person };
    if (group) group.push(normalized);
    else groups.set(person, [normalized]);
  }
  const resolved = [...groups.values()].flat();
  for (const page of pages([...groups.entries()], journeySplitPageSize)) {
    const entries = page.flatMap(([, group]) => group);
    const people = page.map(([person]) => person);
    // The family is resolved for this page of people only and dropped with it, as the holdout
    // report does (#1096, #1105).
    const scope = await pageOutcomeScope(deps.tx, ws, people, pageProfileLimit);
    if (scope.unresolved) unresolved.add(scope.unresolved);
    const outcomes = await deps.events.journeyHoldoutOutcomes(ws, {
      journeyId: input.journeyId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      profileIds: scope.profileIds,
    });
    // A page that resolved reads its whole family, so an outcome stored under a merged-away id
    // still lands on the person's entry. Over the guard the page is read by stored id only.
    const outcomePerson = (id: string) => scope.byProfile.get(id) ?? personKey(id);
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
    // Every entry belongs to exactly one page, so the pages' counts add up.
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i]!;
      count.entered += pageCounts[i]?.entered ?? 0;
      count.converted += pageCounts[i]?.converted ?? 0;
      count.unsubscribed += pageCounts[i]?.unsubscribed ?? 0;
    }
  }

  const rate = (n: number, of: number) => (of ? n / of : 0);
  // The same k floor the holdout read applies, per arm (#757): an arm below k never reports a
  // count or rate, and no comparison or verdict is computed from a hidden baseline. The floor
  // counts distinct people, not entries: one person re-entering an arm five times is still one
  // person (0.14.11 review), and a person whose two ids were merged is one person too, which is
  // why the entries are counted after their ids resolve to their person (#1105 review).
  const armPeople = splitArmPeople(resolved, weights.length).map((n) => ({ entered: n }));
  const belowK = anyArmBelowK(armPeople);
  const arms = counts.map((c, i) =>
    belowK && armPeople[i]!.entered < K
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
  const comparisons: JourneySplitComparison[] = belowK
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
  const baseNote = !taken.length
    ? 'Nobody has reached this split yet.'
    : belowK
      ? `An arm has fewer than k=${K} people, so its counts and rates and every comparison are withheld.`
      : better.length
        ? `${better.join(', ')} converts better than arm 0 with a 95% interval above zero.`
        : comparisons.every((c) => c.verdict === 'not_enough_data')
          ? `Not enough people yet: each arm needs ${input.minSampleSize}.`
          : 'No arm is clearly better than arm 0 yet.';
  const note =
    unresolved.size === 0
      ? baseNote
      : `${baseNote} ${[...unresolved].map((reason) => unresolvedOutcomeNote(reason, pageProfileLimit)).join(' ')}`;
  return { journeyId: input.journeyId, node: input.node, k: K, suppressed: belowK, arms, comparisons, note };
}
