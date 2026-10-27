// The metric catalogue (ADR-0010, #75). It lives in code, next to the query compiler, so a
// metric cannot drift from its definition in a database row. Everything the query surface and
// the UI offer comes from here; the compiler refuses anything that is not in this file.

export type Unit = 'count' | 'ratio' | 'currency';
/** `campaign` is a virtual source: its measures join message events to attributed conversion events. */
export type SourceId = 'message_events' | 'journey_events' | 'events' | 'segment_memberships' | 'campaign';
export type DimensionId =
  | 'day'
  | 'week'
  | 'month'
  | 'channel'
  | 'template'
  | 'broadcast'
  | 'journey'
  | 'journey_step'
  | 'purpose'
  | 'variant'
  | 'message_type'
  | 'segment'
  | 'campaign';

export interface DimensionDef {
  id: DimensionId;
  description: string;
  /** Time grains are never suppressed by k-anonymity; every other dimension is a breakdown. */
  time: boolean;
  sources: readonly SourceId[];
}

export const DIMENSIONS: Record<DimensionId, DimensionDef> = {
  day: {
    id: 'day',
    description: 'Calendar day in the workspace time zone.',
    time: true,
    sources: ['message_events', 'journey_events', 'events'],
  },
  week: {
    id: 'week',
    description: 'Week starting Monday, in the workspace time zone.',
    time: true,
    sources: ['message_events', 'journey_events', 'events'],
  },
  month: {
    id: 'month',
    description: 'Calendar month in the workspace time zone.',
    time: true,
    sources: ['message_events', 'journey_events', 'events'],
  },
  channel: {
    id: 'channel',
    description: 'Delivery channel, e.g. email, sms or push.',
    time: false,
    sources: ['message_events'],
  },
  template: {
    id: 'template',
    description: 'E-mail, SMS or push template id.',
    time: false,
    sources: ['message_events'],
  },
  broadcast: {
    id: 'broadcast',
    description: 'Broadcast id (bct_…), ordered by its first send when used as an order key, so the most recent issues come first.',
    time: false,
    sources: ['message_events'],
  },
  journey: {
    id: 'journey',
    description: 'Journey id (jrn_…) or, for journey events, the journey itself.',
    time: false,
    sources: ['message_events', 'journey_events'],
  },
  journey_step: {
    id: 'journey_step',
    description: 'Journey node id in the order the journey reaches it.',
    time: false,
    sources: ['journey_events'],
  },
  purpose: {
    id: 'purpose',
    description: 'Processing purpose the message was sent under, e.g. marketing_email.',
    time: false,
    sources: ['message_events'],
  },
  variant: {
    id: 'variant',
    description: 'Subject-test variant on the message (A, B, …); empty for messages outside a test.',
    time: false,
    sources: ['message_events'],
  },
  message_type: {
    id: 'message_type',
    description: 'broadcast for bct_ sends, journey for jrn_ sends, transactional when neither applies.',
    time: false,
    sources: ['message_events'],
  },
  segment: {
    id: 'segment',
    description: 'Segment id (seg_…), for the current membership size.',
    time: false,
    sources: ['segment_memberships'],
  },
  campaign: {
    id: 'campaign',
    description: 'Campaign id (cmp_…), resolved from the published campaign’s sending members.',
    time: false,
    sources: ['message_events', 'journey_events', 'campaign'],
  },
};

export const TIME_DIMENSIONS: ReadonlySet<DimensionId> = new Set(['day', 'week', 'month']);

/** What a base measure counts. Kept internal: the catalogue's public face is `aggregation`. */
export type Counting =
  | 'profiles'
  | 'participants'
  | 'events'
  | 'rows'
  | 'revenue'
  | 'segment_members'
  | 'campaign_recipients'
  | 'campaign_converters'
  | 'campaign_revenue';

export interface BaseMeasureDef {
  kind: 'base';
  id: string;
  description: string;
  unit: Unit;
  source: SourceId;
  aggregation: string;
  counting: Counting;
  /** Message or journey event types this measure counts, for the compiler. */
  eventTypes?: readonly string[];
  dimensions: readonly DimensionId[];
  defaultGrain: DimensionId | null;
}

export interface RatioMeasureDef {
  kind: 'ratio';
  id: string;
  description: string;
  /** Ratios are `ratio`, except revenue per recipient, which is money per person. */
  unit: Unit;
  source: SourceId;
  aggregation: 'ratio';
  numerator: string;
  denominator: string;
  dimensions: readonly DimensionId[];
  defaultGrain: DimensionId | null;
}

export type MeasureDef = BaseMeasureDef | RatioMeasureDef;

const EMAIL_DIMENSIONS = [
  'day',
  'week',
  'month',
  'channel',
  'template',
  'broadcast',
  'journey',
  'purpose',
  'variant',
  'message_type',
  'campaign',
] as const;
const JOURNEY_DIMENSIONS = ['day', 'week', 'month', 'journey', 'journey_step', 'campaign'] as const;
const EVENT_DIMENSIONS = ['day', 'week', 'month'] as const;
const SEGMENT_DIMENSIONS = ['segment'] as const;
const CAMPAIGN_DIMENSIONS = ['day', 'week', 'month', 'campaign'] as const;

const emailBase = (
  id: string,
  type: string,
  description: string,
  dimensions: readonly DimensionId[] = EMAIL_DIMENSIONS,
): BaseMeasureDef => ({
  kind: 'base',
  id,
  description,
  unit: 'count',
  source: 'message_events',
  aggregation: 'distinct profiles',
  counting: 'profiles',
  eventTypes: [type],
  dimensions,
  defaultGrain: 'day',
});

const emailRatio = (id: string, numerator: string, denominator: string, description: string): RatioMeasureDef => ({
  kind: 'ratio',
  id,
  description,
  unit: 'ratio',
  source: 'message_events',
  aggregation: 'ratio',
  numerator,
  denominator,
  dimensions: EMAIL_DIMENSIONS,
  defaultGrain: 'day',
});

const journeyBase = (
  id: string,
  eventTypes: readonly string[],
  description: string,
  dimensions: readonly DimensionId[] = JOURNEY_DIMENSIONS,
): BaseMeasureDef => ({
  kind: 'base',
  id,
  description,
  unit: 'count',
  source: 'journey_events',
  aggregation: 'distinct participants',
  counting: 'participants',
  eventTypes,
  dimensions,
  defaultGrain: 'day',
});

const measures: MeasureDef[] = [
  emailBase('email.sent', 'sent', 'Distinct people the send gateway sent an e-mail to. Test sends are excluded.'),
  emailBase('email.delivered', 'delivered', 'Distinct people whose e-mail the provider delivered.'),
  emailBase('email.bounced', 'bounced', 'Distinct people whose e-mail bounced.'),
  emailBase('email.complained', 'complained', 'Distinct people who reported the e-mail as spam.'),
  emailBase('email.opened', 'opened', 'Distinct people who opened the e-mail. Only where pixel tracking is enabled.'),
  emailBase('email.clicked', 'clicked', 'Distinct people who clicked at least one tracked link.'),
  emailBase('email.unsubscribed', 'unsubscribed', 'Distinct people who unsubscribed from the e-mail’s purpose.'),
  emailRatio('email.click_rate', 'email.clicked', 'email.delivered', 'Distinct clickers divided by distinct people delivered.'),
  emailRatio('email.bounce_rate', 'email.bounced', 'email.sent', 'Distinct bounces divided by distinct people sent.'),
  emailRatio('email.complaint_rate', 'email.complained', 'email.sent', 'Distinct spam complaints divided by distinct people sent.'),
  emailRatio(
    'email.unsubscribe_rate',
    'email.unsubscribed',
    'email.delivered',
    'Distinct unsubscribes divided by distinct people delivered.',
  ),
  emailRatio(
    'email.open_rate',
    'email.opened',
    'email.delivered',
    'Distinct openers divided by distinct people delivered. Only where tracking is enabled.',
  ),

  journeyBase('journey.entered', ['entered'], 'Distinct participants who entered the journey.'),
  journeyBase('journey.completed', ['completed'], 'Distinct participants who reached the end of the journey.'),
  journeyBase('journey.exited', ['exited'], 'Distinct participants who exited before the end, including consent withdrawals.'),
  journeyBase('journey.goal_reached', ['converted'], 'Distinct participants who reached the journey’s goal.'),
  journeyBase('journey.step_reached', ['step', 'resumed'], 'Distinct participants who reached each step.'),
  {
    kind: 'base',
    id: 'journey.failed',
    description: 'Failed journey steps: each recorded failure, not each participant. Use the journey filter to watch one journey.',
    unit: 'count',
    source: 'journey_events',
    aggregation: 'count',
    counting: 'rows',
    eventTypes: ['failed'],
    dimensions: JOURNEY_DIMENSIONS,
    defaultGrain: 'day',
  },

  {
    kind: 'base',
    id: 'conversions',
    description:
      'Distinct conversion events (by event id) named by the published conversion map, or by filters.name. One event per person counts once per occurrence.',
    unit: 'count',
    source: 'events',
    aggregation: 'distinct events',
    counting: 'events',
    dimensions: EVENT_DIMENSIONS,
    defaultGrain: 'day',
  },
  {
    kind: 'base',
    id: 'revenue',
    description:
      'Sum of the conversion value property named by the conversion map, per currency. A rule without a value contributes 0; different currencies are never added together.',
    unit: 'currency',
    source: 'events',
    aggregation: 'sum',
    counting: 'revenue',
    dimensions: EVENT_DIMENSIONS,
    defaultGrain: 'day',
  },
  {
    kind: 'base',
    id: 'segment.members',
    description: 'People in a segment right now, read from Postgres. The current size ignores from/to.',
    unit: 'count',
    source: 'segment_memberships',
    aggregation: 'distinct profiles',
    counting: 'segment_members',
    dimensions: SEGMENT_DIMENSIONS,
    defaultGrain: null,
  },

  // Campaign evaluation (#66). These read message_events for the published campaign's sending
  // members and events for the goal; they cannot share a query with the per-channel measures
  // because the compiler's source is a single table.
  {
    kind: 'base',
    id: 'campaign.recipients',
    description: 'Distinct people who got a sent or delivered message from a campaign member in the range.',
    unit: 'count',
    source: 'campaign',
    aggregation: 'distinct profiles',
    counting: 'campaign_recipients',
    dimensions: CAMPAIGN_DIMENSIONS,
    defaultGrain: 'day',
  },
  {
    kind: 'base',
    id: 'campaign.converters',
    description:
      'Distinct people who converted within the campaign goal’s attribution window, counted from their first campaign message (first touch). A person reached by two campaigns can count for both.',
    unit: 'count',
    source: 'campaign',
    aggregation: 'distinct profiles',
    counting: 'campaign_converters',
    dimensions: CAMPAIGN_DIMENSIONS,
    defaultGrain: 'day',
  },
  {
    kind: 'ratio',
    id: 'campaign.conversion_rate',
    description: 'Campaign converters divided by campaign recipients.',
    unit: 'ratio',
    source: 'campaign',
    aggregation: 'ratio',
    numerator: 'campaign.converters',
    denominator: 'campaign.recipients',
    dimensions: CAMPAIGN_DIMENSIONS,
    defaultGrain: 'day',
  },
  {
    kind: 'base',
    id: 'campaign.revenue',
    description: 'Revenue from attributed campaign conversions, per currency. Different currencies are never added together.',
    unit: 'currency',
    source: 'campaign',
    aggregation: 'sum',
    counting: 'campaign_revenue',
    dimensions: CAMPAIGN_DIMENSIONS,
    defaultGrain: 'day',
  },
  {
    kind: 'ratio',
    id: 'campaign.revenue_per_recipient',
    description: 'Attributed revenue divided by campaign recipients, in the conversion currency.',
    unit: 'currency',
    source: 'campaign',
    aggregation: 'ratio',
    numerator: 'campaign.revenue',
    denominator: 'campaign.recipients',
    dimensions: CAMPAIGN_DIMENSIONS,
    defaultGrain: 'day',
  },
];

export const MEASURES: Record<string, MeasureDef> = Object.fromEntries(measures.map((m) => [m.id, m]));

/** Dimension ids a set of measures can all be broken down by. */
export function commonDimensions(list: readonly MeasureDef[]): DimensionId[] {
  if (!list.length) return [];
  return list[0].dimensions.filter((d) => list.every((m) => m.dimensions.includes(d)));
}

export function measureIds(): string[] {
  return measures.map((m) => m.id);
}

/** The public catalogue, used by analytics.metrics.list and the UI picker. */
export const METRIC_CATALOG = {
  measures: measures.map((m) =>
    m.kind === 'ratio'
      ? {
          id: m.id,
          description: m.description,
          unit: m.unit,
          aggregation: m.aggregation,
          source: m.source,
          dimensions: [...m.dimensions],
          defaultGrain: m.defaultGrain,
          kind: m.kind,
          numerator: m.numerator,
          denominator: m.denominator,
        }
      : {
          id: m.id,
          description: m.description,
          unit: m.unit,
          aggregation: m.aggregation,
          source: m.source,
          dimensions: [...m.dimensions],
          defaultGrain: m.defaultGrain,
          kind: m.kind,
        },
  ),
  dimensions: Object.values(DIMENSIONS).map((d) => ({
    id: d.id,
    description: d.description,
    time: d.time,
    sources: [...d.sources],
  })),
} as const;
