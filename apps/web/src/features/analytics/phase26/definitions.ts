// The Analytics screen's fixed questions (#506). Presets are local definitions: the three fixed
// questions, the grouped measure picker, and the ratio bases that keep a picked rate coherent.
// Nothing here is persisted; the server catalogue still decides which measures exist.

export type PresetId = 'newsletter' | 'journey' | 'deliverability';
export type AnalyticsSource = 'message_events' | 'journey_events' | 'events';
export type MeasureGroupId = 'delivery' | 'engagement' | 'journey' | 'conversion';

export interface MeasureGroup {
  id: MeasureGroupId;
  label: string;
  source: AnalyticsSource;
  /** Every measure in the group, in the order the picker shows them. */
  measures: string[];
  /** The selection a source switch installs. */
  defaults: string[];
  hint: string;
}

export const MAX_MEASURES = 10;

/** Ratio numerator/denominator from packages/analytics/src/registry.ts. A ratio is never selected without both. */
export const RATIO_BASES: Record<string, [string, string]> = {
  'email.click_rate': ['email.clicked', 'email.delivered'],
  'email.open_rate': ['email.opened', 'email.delivered'],
  'email.unsubscribe_rate': ['email.unsubscribed', 'email.delivered'],
  'email.bounce_rate': ['email.bounced', 'email.sent'],
  'email.complaint_rate': ['email.complained', 'email.sent'],
  'campaign.conversion_rate': ['campaign.converters', 'campaign.recipients'],
  'campaign.revenue_per_recipient': ['campaign.revenue', 'campaign.recipients'],
};

export const MEASURE_GROUPS: MeasureGroup[] = [
  {
    id: 'delivery',
    label: 'Delivery',
    source: 'message_events',
    measures: ['email.sent', 'email.delivered', 'email.bounced', 'email.complained'],
    defaults: ['email.sent', 'email.delivered', 'email.bounced', 'email.complained'],
    hint: 'Distinct people the send gateway sent to, delivered, bounced or complained.',
  },
  {
    id: 'engagement',
    label: 'Tracked engagement',
    source: 'message_events',
    measures: ['email.opened', 'email.clicked', 'email.unsubscribed', 'email.open_rate', 'email.click_rate', 'email.unsubscribe_rate'],
    defaults: ['email.opened', 'email.clicked', 'email.unsubscribed', 'email.open_rate', 'email.click_rate', 'email.unsubscribe_rate'],
    hint: 'Opens and clicks are tracked people; a rate always carries its delivered-person base.',
  },
  {
    id: 'journey',
    label: 'Journey progress',
    source: 'journey_events',
    measures: ['journey.entered', 'journey.goal_reached', 'journey.completed', 'journey.exited', 'journey.failed', 'journey.step_reached'],
    defaults: ['journey.entered', 'journey.goal_reached', 'journey.completed', 'journey.exited', 'journey.failed'],
    hint: 'Distinct participants by the event they recorded in the period.',
  },
  {
    id: 'conversion',
    label: 'Conversion value',
    source: 'events',
    measures: ['conversions', 'revenue'],
    defaults: ['conversions', 'revenue'],
    hint: 'Distinct conversion events and the value they carry, grouped by their own currency.',
  },
];

export const GROUP_BY_MEASURE: Record<string, MeasureGroup> = Object.fromEntries(
  MEASURE_GROUPS.flatMap((group) => group.measures.map((measure) => [measure, group] as const)),
);

export const CONVERSION_MEASURES = ['conversions', 'revenue'] as const;

export function measureGroupOf(measureId: string): MeasureGroup | undefined {
  return GROUP_BY_MEASURE[measureId];
}

/** The ratio bases that must accompany a selected ratio. */
export function ratioBasesOf(measureIds: readonly string[]): string[] {
  const bases: string[] = [];
  for (const id of measureIds) {
    const pair = RATIO_BASES[id];
    if (!pair) continue;
    for (const base of pair) if (!measureIds.includes(base) && !bases.includes(base)) bases.push(base);
  }
  return bases;
}

/**
 * The query's measure list: the selection plus every ratio base, deduplicated. A preset already
 * names all of its bases, so its exact read order is preserved.
 */
export function resolveMeasures(measureIds: readonly string[]): string[] {
  const out = [...new Set(measureIds)];
  for (const base of ratioBasesOf(out)) out.push(base);
  return out;
}

/** True when adding `next` would exceed the cap including ratio bases and would truncate silently. */
export function wouldExceedCap(measureIds: readonly string[], next: string): boolean {
  return resolveMeasures([...measureIds, next]).length > MAX_MEASURES;
}

export type MeasureToggle = { measures: string[] } | { error: 'cap' | 'keep-one' };

/**
 * Toggle one measure while keeping every selected ratio's numerator and denominator. Adding a
 * ratio also adds its bases; removing a base removes the ratios that cannot stand without it.
 * The 10-measure cap counts the bases, so nothing is dropped silently.
 */
export function toggleMeasureSelection(selected: readonly string[], id: string): MeasureToggle {
  const removing = selected.includes(id);
  let next = removing ? selected.filter((measure) => measure !== id) : [...selected, id];
  if (!next.length) return { error: 'keep-one' };
  if (removing) {
    // Remove a base and the ratios that cannot stand without it go too.
    next = next.filter((measure) => {
      const pair = RATIO_BASES[measure];
      return !pair || pair.every((base) => next.includes(base));
    });
  } else {
    // Adding a ratio first brings its numerator and denominator, then the invariant is checked.
    for (const measure of [...next]) {
      const pair = RATIO_BASES[measure];
      if (!pair) continue;
      for (const base of pair) if (!next.includes(base)) next.push(base);
    }
    next = next.filter((measure) => {
      const pair = RATIO_BASES[measure];
      return !pair || pair.every((base) => next.includes(base));
    });
  }
  if (next.length > MAX_MEASURES) return { error: 'cap' };
  return { measures: next };
}

export interface Preset {
  id: PresetId;
  label: string;
  question: string;
  source: AnalyticsSource;
  /** Exact measures in both the totals and series reads. */
  measures: string[];
  /** Measures the chart leads with. */
  chart: string[];
  /** Measures in the summary tiles. */
  tiles: string[];
  sourceGroup: MeasureGroupId;
  note: string;
}

export const PRESET_ORDER: PresetId[] = ['newsletter', 'journey', 'deliverability'];

export const PRESETS: Record<PresetId, Preset> = {
  newsletter: {
    id: 'newsletter',
    label: 'Newsletter performance',
    question: 'What changed in your newsletter results?',
    source: 'message_events',
    measures: [
      'email.sent',
      'email.delivered',
      'email.opened',
      'email.clicked',
      'email.unsubscribed',
      'email.open_rate',
      'email.click_rate',
      'email.unsubscribe_rate',
    ],
    chart: ['email.delivered', 'email.clicked'],
    tiles: ['email.delivered', 'email.click_rate', 'email.unsubscribed', 'email.open_rate'],
    sourceGroup: 'delivery',
    note: 'Daily unique people are not added to period totals. Tracked engagement coverage may vary.',
  },
  journey: {
    id: 'journey',
    label: 'Journey conversion',
    question: 'How many people moved through the journey?',
    source: 'journey_events',
    measures: ['journey.entered', 'journey.goal_reached', 'journey.completed', 'journey.exited', 'journey.failed'],
    chart: ['journey.entered', 'journey.goal_reached'],
    tiles: ['journey.entered', 'journey.goal_reached'],
    sourceGroup: 'journey',
    note: 'Event-period ratio, not a cohort funnel. Goal reached can exceed entered in a period.',
  },
  deliverability: {
    id: 'deliverability',
    label: 'Deliverability',
    question: 'How healthy was delivery in this period?',
    source: 'message_events',
    measures: ['email.sent', 'email.bounced', 'email.complained', 'email.bounce_rate', 'email.complaint_rate'],
    chart: ['email.bounce_rate', 'email.complaint_rate'],
    tiles: ['email.bounce_rate', 'email.complaint_rate', 'email.sent'],
    sourceGroup: 'delivery',
    note: 'Event-date people, not pause-policy message cohorts. No policy lines.',
  },
};

/** The picker group that owns a selection source. Email keeps the current email question. */
export function groupForSource(source: AnalyticsSource, currentPreset?: PresetId | 'conversion'): MeasureGroup {
  if (source === 'journey_events') return MEASURE_GROUPS.find((group) => group.id === 'journey')!;
  if (source === 'events') return MEASURE_GROUPS.find((group) => group.id === 'conversion')!;
  const current = currentPreset && currentPreset !== 'conversion' ? PRESETS[currentPreset] : null;
  if (current?.source === 'message_events') {
    return MEASURE_GROUPS.find((group) => group.id === current.sourceGroup)!;
  }
  return MEASURE_GROUPS.find((group) => group.id === 'delivery')!;
}

/**
 * A preset for the source, or the conversion-value selection that is reachable from the picker
 * but is not one of the three fixed questions.
 */
export function presetForGroup(group: MeasureGroup): PresetId | 'conversion' {
  if (group.source === 'journey_events') return 'journey';
  if (group.source === 'events') return 'conversion';
  return 'newsletter';
}

/** The closest question and source for a deep-linked measure list. */
export function selectionForMeasures(measureIds: readonly string[]): { preset: PresetId | 'conversion'; source: AnalyticsSource } {
  const groups = measureIds.map(measureGroupOf);
  if (!groups.length || groups.some((group) => !group)) return { preset: 'newsletter', source: 'message_events' };
  if (groups.every((group) => group!.source === 'events')) return { preset: 'conversion', source: 'events' };
  if (groups.every((group) => group!.source === 'journey_events')) return { preset: 'journey', source: 'journey_events' };
  if (groups.every((group) => group!.source === 'message_events')) {
    const deliverability = measureIds.some(
      (id) => id === 'email.bounce_rate' || id === 'email.complaint_rate' || id === 'email.bounced' || id === 'email.complained',
    );
    return { preset: deliverability ? 'deliverability' : 'newsletter', source: 'message_events' };
  }
  return { preset: 'newsletter', source: 'message_events' };
}
