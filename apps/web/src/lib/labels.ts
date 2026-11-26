import { TYPE_LABEL } from '../app/artifactRoutes';
import { ACTION_CLASS_LABEL, AGENT_DECISION_LABEL, actionClassLabel, agentDecisionLabel } from './agentLabels';

export { ACTION_CLASS_LABEL, AGENT_DECISION_LABEL, actionClassLabel, agentDecisionLabel };

// The label registry (#437): one place that turns API keys into the words people read. Analytics
// pickers, chart/table headers, agent activity, artifact types, event types and purposes all use
// these; raw keys stay in technical details and command input, never in a heading or a picker.

export type MetricUnit = 'count' | 'ratio' | 'currency';

export interface MeasureLabel {
  label: string;
  unit: MetricUnit;
  description: string;
  /** The ratio's denominator in words, shown in a chart subtitle. */
  denominator?: string;
}

export interface DimensionLabel {
  label: string;
  description: string;
}

/**
 * Every measure `analytics.metrics.list` returns. The coverage test in `apps/web/test/labels.test.ts`
 * reads `packages/analytics/src/registry.ts` and fails when a measure is added without a label.
 */
export const ANALYTICS_MEASURES: Record<string, MeasureLabel> = {
  'email.sent': {
    label: 'E-mails sent',
    unit: 'count',
    description: 'Distinct people the send gateway sent an e-mail to. Test sends are excluded.',
  },
  'email.delivered': {
    label: 'Delivered',
    unit: 'count',
    description: 'Distinct people whose e-mail the provider delivered.',
  },
  'email.bounced': {
    label: 'Bounced',
    unit: 'count',
    description: 'Distinct people whose e-mail bounced.',
  },
  'email.complained': {
    label: 'Spam complaints',
    unit: 'count',
    description: 'Distinct people who reported the e-mail as spam.',
  },
  'email.opened': {
    label: 'Opened',
    unit: 'count',
    description: 'Distinct people who opened the e-mail. Only where pixel tracking is enabled.',
  },
  'email.clicked': {
    label: 'Clicked',
    unit: 'count',
    description: 'Distinct people who clicked at least one tracked link.',
  },
  'email.unsubscribed': {
    label: 'Unsubscribed',
    unit: 'count',
    description: 'Distinct people who unsubscribed from the e-mail’s purpose.',
  },
  'email.click_rate': {
    label: 'Click rate',
    unit: 'ratio',
    description: 'Distinct clickers divided by distinct people delivered.',
    denominator: 'delivered people',
  },
  'email.bounce_rate': {
    label: 'Bounce rate',
    unit: 'ratio',
    description: 'Distinct bounces divided by distinct people sent.',
    denominator: 'sent people',
  },
  'email.complaint_rate': {
    label: 'Complaint rate',
    unit: 'ratio',
    description: 'Distinct spam complaints divided by distinct people sent.',
    denominator: 'sent people',
  },
  'email.unsubscribe_rate': {
    label: 'Unsubscribe rate',
    unit: 'ratio',
    description: 'Distinct unsubscribes divided by distinct people delivered.',
    denominator: 'delivered people',
  },
  'email.open_rate': {
    label: 'Open rate',
    unit: 'ratio',
    description: 'Distinct openers divided by distinct people delivered. Only where tracking is enabled.',
    denominator: 'delivered people',
  },
  'journey.entered': {
    label: 'Entered',
    unit: 'count',
    description: 'Distinct participants who entered the journey.',
  },
  'journey.completed': {
    label: 'Completed',
    unit: 'count',
    description: 'Distinct participants who reached the end of the journey.',
  },
  'journey.exited': {
    label: 'Exited',
    unit: 'count',
    description: 'Distinct participants who exited before the end, including consent withdrawals.',
  },
  'journey.goal_reached': {
    label: 'Goal reached',
    unit: 'count',
    description: 'Distinct participants who reached the journey’s goal.',
  },
  'journey.step_reached': {
    label: 'Step reached',
    unit: 'count',
    description: 'Distinct participants who reached each step.',
  },
  'journey.failed': {
    label: 'Failed steps',
    unit: 'count',
    description: 'Failed journey steps: each recorded failure, not each participant.',
  },
  conversions: {
    label: 'Conversions',
    unit: 'count',
    description: 'Distinct conversion events named by the published conversion map, or by filters.name.',
  },
  revenue: {
    label: 'Revenue',
    unit: 'currency',
    description: 'Sum of the conversion value property named by the conversion map, per currency.',
  },
  'segment.members': {
    label: 'Segment members',
    unit: 'count',
    description: 'People in a segment right now, read from Postgres; the current size ignores from/to.',
  },
  'campaign.recipients': {
    label: 'Campaign recipients',
    unit: 'count',
    description: 'Distinct people who got a sent or delivered message from a campaign member in the range.',
  },
  'campaign.converters': {
    label: 'Campaign converters',
    unit: 'count',
    description: 'Distinct people who converted within the campaign goal’s attribution window.',
  },
  'campaign.conversion_rate': {
    label: 'Campaign conversion rate',
    unit: 'ratio',
    description: 'Campaign converters divided by campaign recipients.',
    denominator: 'campaign recipients',
  },
  'campaign.revenue': {
    label: 'Campaign revenue',
    unit: 'currency',
    description: 'Revenue from attributed campaign conversions, per currency.',
  },
  'campaign.revenue_per_recipient': {
    label: 'Revenue per recipient',
    unit: 'currency',
    description: 'Attributed revenue divided by campaign recipients, in the conversion currency.',
    denominator: 'campaign recipients',
  },
};

/** Every dimension `analytics.metrics.list` returns. */
export const ANALYTICS_DIMENSIONS: Record<string, DimensionLabel> = {
  day: { label: 'Day', description: 'Calendar day in the workspace time zone.' },
  week: { label: 'Week', description: 'Week starting Monday, in the workspace time zone.' },
  month: { label: 'Month', description: 'Calendar month in the workspace time zone.' },
  channel: { label: 'Channel', description: 'Delivery channel, e.g. e-mail, SMS or push.' },
  template: { label: 'Template', description: 'E-mail, SMS or push template.' },
  broadcast: { label: 'Broadcast', description: 'Broadcast, ordered by its first send when it is the order key.' },
  journey: { label: 'Journey', description: 'Journey, for message and journey events.' },
  journey_step: { label: 'Journey step', description: 'Journey node in the order the journey reaches it.' },
  purpose: { label: 'Purpose', description: 'Processing purpose the message was sent under.' },
  variant: { label: 'Subject variant', description: 'Subject-test variant on the message; empty outside a test.' },
  message_type: {
    label: 'Message type',
    description: 'Broadcast, journey or transactional, from the message’s send.',
  },
  segment: { label: 'Segment', description: 'Segment, for its current membership size.' },
  campaign: { label: 'Campaign', description: 'Campaign, resolved from its published sending members.' },
};

const humanise = (key: string) =>
  key
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSms\b/g, 'SMS');

/** A sentence-case fallback for event labels: "provider_accepted" reads as "Provider accepted". */
const humaniseSentence = (key: string) => {
  const text = key.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return (text.charAt(0).toUpperCase() + text.slice(1)).replace(/\bsms\b/g, 'SMS').replace(/\bapi\b/g, 'API');
};

/** Only a fallback for a key added to the API before this registry; the coverage test blocks that. */
export function measureLabel(id: string): string {
  return ANALYTICS_MEASURES[id]?.label ?? humanise(id);
}

export function measureDescription(id: string): string | undefined {
  return ANALYTICS_MEASURES[id]?.description;
}

export function measureUnit(id: string): MetricUnit | undefined {
  return ANALYTICS_MEASURES[id]?.unit;
}

export function dimensionLabel(id: string): string {
  return ANALYTICS_DIMENSIONS[id]?.label ?? humanise(id);
}

export function dimensionDescription(id: string): string | undefined {
  return ANALYTICS_DIMENSIONS[id]?.description;
}

/** A table column may be a measure or a dimension. */
export function metricLabel(id: string): string {
  return ANALYTICS_MEASURES[id]?.label ?? ANALYTICS_DIMENSIONS[id]?.label ?? humanise(id);
}

export const METRIC_UNIT_LABEL: Record<MetricUnit, string> = {
  count: 'Count',
  ratio: 'Rate',
  currency: 'Currency',
};

/** Artifact type words; `artifactRoutes` owns the map because routing and labels use it together. */
export const ARTIFACT_TYPE_LABEL = TYPE_LABEL;

export function artifactTypeLabel(type: string): string {
  return ARTIFACT_TYPE_LABEL[type] ?? humanise(type);
}

/** Message and journey event types, then the inbound tracking event kinds. */
export const EVENT_TYPE_LABEL: Record<string, string> = {
  queued: 'Queued',
  sent: 'Sent',
  suppressed: 'Suppressed',
  failed: 'Failed',
  delivered: 'Delivered',
  bounced: 'Bounced',
  deferred: 'Deferred',
  complained: 'Complained',
  opened: 'Opened',
  clicked: 'Clicked',
  unsubscribed: 'Unsubscribed',
  entered: 'Entered',
  step: 'Step reached',
  waiting: 'Waiting',
  resumed: 'Resumed',
  converted: 'Converted',
  completed: 'Completed',
  exited: 'Exited',
  holdout_assigned: 'Holdout assigned',
  track: 'Tracked event',
  page: 'Page view',
  screen: 'Screen view',
  identify: 'Identity',
  group: 'Group',
  alias: 'Alias',
};

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABEL[type] ?? humaniseSentence(type);
}

/**
 * Known message reason codes, kept before their `: guidance` so the recovery text survives
 * (#1260 review). An unknown code is returned unchanged rather than being silently rewritten.
 */
export const MESSAGE_REASON_LABEL: Record<string, string> = {
  unknown_outcome: 'Outcome unknown',
  delivery_error: 'Delivery failed',
  provider_error: 'Provider error',
  no_template: 'Template unavailable',
  not_published: 'Template not published',
  no_profile: 'Person not found',
  no_address: 'No e-mail address',
  unknown_purpose: 'Purpose not configured',
  no_lawful_basis: 'No lawful basis',
  suppressed: 'Suppressed',
};

export function messageReasonLabel(reason: string): string {
  const separator = reason.indexOf(':');
  const code = separator < 0 ? reason : reason.slice(0, separator);
  const label = MESSAGE_REASON_LABEL[code];
  if (!label) return reason;
  const guidance = separator < 0 ? '' : reason.slice(separator + 1).trim();
  return guidance ? `${label}: ${guidance}` : label;
}

/**
 * AI call kinds, in the order the "Filter by kind" picker offers them (#1255, #1260). The page
 * derives its options from this map, so a new kind gains a picker entry only with its label.
 */
export const AI_CALL_KIND_LABEL: Record<string, string> = {
  decide: 'Journey decision',
  generate: 'Text generation',
  copilot: 'Copilot',
  test: 'Prompt test',
  classify: 'Classification',
  check: 'Independent check',
  hosted: 'Hosted agent',
  score: 'Scoring',
};

export function aiCallKindLabel(kind: string): string {
  return AI_CALL_KIND_LABEL[kind] ?? humanise(kind);
}

/** AI call statuses in the decision log. */
export const AI_CALL_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  fallback: 'Fallback',
  failed: 'Failed',
};

export function aiCallStatusLabel(status: string): string {
  return AI_CALL_STATUS_LABEL[status] ?? humanise(status);
}

/** Delivery channels, then message statuses, for the Messages page (#1260). */
export const MESSAGE_CHANNEL_LABEL: Record<string, string> = {
  email: 'E-mail',
  sms: 'SMS',
  push: 'Push',
};

export function messageChannelLabel(channel: string): string {
  return MESSAGE_CHANNEL_LABEL[channel] ?? humanise(channel);
}

export const MESSAGE_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  suppressed: 'Suppressed',
  failed: 'Failed',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Complained',
};

export function messageStatusLabel(status: string): string {
  return MESSAGE_STATUS_LABEL[status] ?? humanise(status);
}

/** Default purpose names; a workspace's published purposes replace these where they exist. */
export const PURPOSE_LABEL: Record<string, string> = {
  necessary: 'Strictly necessary',
  analytics: 'Analytics',
  web_personalization: 'Personalization',
  onboarding: 'Service messages',
  marketing_email: 'Marketing e-mail',
  marketing_sms: 'Marketing SMS',
  service_sms: 'Service texts',
  marketing_push: 'Marketing notifications',
  service_push: 'Service notifications',
  ad_measurement: 'Ad measurement',
  ad_targeting: 'Ad personalization',
  ai_processing: 'AI personalization',
};

/**
 * A purpose in the workspace's own words when its published purposes are available, else the
 * default name. A saved but unresolved purpose is named "Unavailable purpose"; its key belongs in
 * the copy affordance, never in a label.
 */
export function purposeLabel(key: string, purposes?: readonly { key: string; name: string }[] | null): string {
  return purposes?.find((p) => p.key === key)?.name ?? PURPOSE_LABEL[key] ?? 'Unavailable purpose';
}

/** The GDPR lawful bases in the words people read; the server stores the keys (#1173). */
export const LAWFUL_BASIS_LABEL: Record<string, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
};

/**
 * A lawful basis for display. Null means the purpose has none, so the caller makes no claim; a
 * basis this build does not know still loses its underscores rather than showing a raw key.
 */
export function lawfulBasisLabel(basis: string | null | undefined): string | null {
  if (!basis) return null;
  return LAWFUL_BASIS_LABEL[basis] ?? basis.replace(/_/g, ' ');
}
