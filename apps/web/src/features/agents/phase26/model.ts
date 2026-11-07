import type { Out } from '../../../app/api';
import { measureLabel, measureUnit } from '../../../lib/labels';
import { formatDate, formatDateTime, getWorkspaceTimeZone } from '../../../ui/time';
import type { MandateContent } from '../../artifacts/MandateEditor';
import { returnedPeriodLabel as returnedPeriodLabelFromBounds } from '../../broadcasts/period';
import { AGENT_STATUS, AUTONOMY_LEVEL, type Autonomy, actionClassLabel, levelFor, MANDATE_CLASSES } from '../labels';

// Pure reads and formatting for the Phase 26 agent page (#509). The server owns the action
// tallies, the mandate selection and the comparison; this module only names units, keeps the
// broadcast people lane apart from direct messages, and turns missing values into Unavailable
// instead of an observed zero.

export type AgentDetail = Out<'agents.get'>;
export type AgentReport = Out<'agents.report'>;
export type AgentMandate = Out<'agents.mandate'>;
export type AgentActivity = Out<'agents.activity'>;
export type AgentActionRow = AgentActivity['actions'][number];
export type AgentComparison = Out<'agents.compare'>;
export type ComparisonAgent = AgentComparison['agents'][number];
export type Outcomes = NonNullable<AgentReport['outcomes']>;
export type BroadcastOutcome = NonNullable<Outcomes['broadcasts']>;
export type DirectOutcome = NonNullable<Outcomes['direct']>;
export type GoalOutcome = Outcomes['goals'][number];
export type ReportActions = AgentReport['actions'];
export type AutonomySettings = Autonomy;

export const MIN_YEAR = 2000;

/** A real instant, never the epoch a null or missing server value turns into. */
export function isRealInstant(value: string | null | undefined): value is string {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= MIN_YEAR;
}

export function safeDateText(value: string | null | undefined): string {
  return isRealInstant(value) ? formatDate(value) : 'Unavailable';
}

export function safeDateTimeText(value: string | null | undefined): string {
  return isRealInstant(value) ? formatDateTime(value) : 'Unavailable';
}

export function fetchedText(value: Date | string | null | undefined): string {
  if (!value) return 'Fetched time unavailable';
  const iso = value instanceof Date ? value.toISOString() : value;
  return isRealInstant(iso) ? `Fetched ${formatDateTime(iso)}` : 'Fetched time unavailable';
}

export function computedText(value: string | null | undefined): string {
  return isRealInstant(value) ? `Computed ${formatDateTime(value)}` : 'Computed time unavailable';
}

export function intText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}

export function percentText(numerator: number | null | undefined, denominator: number | null | undefined): string {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator <= 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function withCountUnit(value: number, one: string, many: string): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;
}

export function zoneOf(): string {
  return getWorkspaceTimeZone();
}

export function returnedPeriodLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (!isRealInstant(from) || !isRealInstant(to)) return 'Period unavailable';
  try {
    return returnedPeriodLabelFromBounds(from, to, zoneOf()) ?? 'Period unavailable';
  } catch {
    return 'Period unavailable';
  }
}

export function reportPeriodLabel(report: Pick<AgentReport, 'from' | 'to'>): string {
  return returnedPeriodLabel(report.from, report.to);
}

export function comparisonPeriodLabel(comparison: Pick<AgentComparison, 'from' | 'to'>): string {
  return returnedPeriodLabel(comparison.from, comparison.to);
}

export type DecisionKey = 'allow' | 'hold' | 'ask' | 'deny' | 'failed';

export const DECISION_ROWS: { key: DecisionKey; label: string }[] = [
  { key: 'allow', label: 'Ran' },
  { key: 'hold', label: 'Held' },
  { key: 'ask', label: 'Asked a person' },
  { key: 'deny', label: 'Refused' },
  { key: 'failed', label: 'Failed' },
];

export function decisionTotals(actions: ReportActions): Record<DecisionKey, number> {
  const total: Record<DecisionKey, number> = { allow: 0, hold: 0, ask: 0, deny: 0, failed: 0 };
  for (const counts of Object.values(actions)) {
    for (const key of DECISION_ROWS) total[key.key] += counts[key.key] ?? 0;
  }
  return total;
}

export function actionRows(actions: ReportActions): { actionClass: string; counts: ReportActions[string] }[] {
  return Object.entries(actions)
    .map(([actionClass, counts]) => ({ actionClass, counts }))
    .sort((a, b) => a.actionClass.localeCompare(b.actionClass));
}

export function goalValueText(measure: string, value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  return measureUnit(measure) === 'ratio' ? `${(value * 100).toFixed(1)}%` : value.toLocaleString('en-US');
}

export function goalTargetText(measure: string, target: number | null | undefined): string {
  if (typeof target !== 'number' || !Number.isFinite(target)) return 'No target';
  return measureUnit(measure) === 'ratio' ? `${(target * 100).toFixed(1)}%` : target.toLocaleString('en-US');
}

export function goalDirectionText(direction: GoalOutcome['direction']): string {
  return direction === 'down' ? 'at most' : 'at least';
}

export function goalMetText(met: boolean | null | undefined): string {
  return met === true ? 'Met' : met === false ? 'Not met' : 'Not measured';
}

export function goalTileExplanation(goal: GoalOutcome): string {
  const target = goalTargetText(goal.measure, goal.target);
  const value = goalValueText(goal.measure, goal.value);
  const targetPart = goal.target === undefined || goal.target === null ? 'No target' : `${goalDirectionText(goal.direction)} ${target}`;
  const parts = [`${value} (${targetPart})`, goalMetText(goal.met)];
  if (goal.note) parts.push(goal.note);
  return parts.join(' · ');
}

export function goalTileValue(goal: GoalOutcome): number | null {
  if (typeof goal.value !== 'number' || !Number.isFinite(goal.value)) return null;
  return measureUnit(goal.measure) === 'ratio' ? goal.value * 100 : goal.value;
}

export function goalTileUnit(goal: GoalOutcome): '%' | 'count' {
  return measureUnit(goal.measure) === 'ratio' ? '%' : 'count';
}

export const OUTCOME_METRICS = [
  { key: 'sent', label: 'Sent' },
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'unsubscribed', label: 'Unsubscribed' },
  { key: 'complained', label: 'Complained' },
  { key: 'bounced', label: 'Bounced' },
] as const;

export type OutcomeMetricKey = (typeof OUTCOME_METRICS)[number]['key'];

export function outcomeValue(lane: BroadcastOutcome | DirectOutcome | null | undefined, key: OutcomeMetricKey): number | null {
  if (!lane) return null;
  const value = lane[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function costText(cost: number | null | undefined): string {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return 'Unavailable';
  return `USD ${cost.toFixed(2)}`;
}

export function goalsText(agent: Pick<ComparisonAgent, 'goalsMet' | 'goalsTotal'>): string {
  if (!agent.goalsTotal) return 'No goals recorded';
  return `${agent.goalsMet.toLocaleString('en-US')} met · ${agent.goalsTotal.toLocaleString('en-US')} recorded`;
}

export function agentStatusText(status: string): string {
  return AGENT_STATUS[status as keyof typeof AGENT_STATUS]?.label ?? status;
}

/** The action classes a mandate can set a level for, in the design's order. */
export const MATRIX_CLASSES = MANDATE_CLASSES;

/** Classes the policy treats as irreversible (packages/commands/src/policy.ts). */
export const IRREVERSIBLE_CLASSES = new Set(['send.broadcast', 'send.direct', 'spend', 'destructive']);

export function grantedLevel(content: MandateContent | null | undefined, actionClass: string): { level: number; set: boolean } {
  const raw = content?.levels?.[actionClass];
  if (typeof raw === 'number' && Number.isFinite(raw)) return { level: raw, set: true };
  return { level: 1, set: false };
}

export function levelText(level: number): string {
  return `${level} · ${AUTONOMY_LEVEL[level] ?? `Level ${level}`}`;
}

export function ceilingLevel(autonomy: AutonomySettings | null | undefined, actionClass: string): number {
  return levelFor(autonomy?.maxLevel ?? {}, actionClass);
}

export function guardianCap(guard: AgentDetail['guard'], actionClass: string): { text: string; cap: number | null; irreversible: boolean } {
  if (!guard) return { text: 'None', cap: null, irreversible: false };
  const irreversible = IRREVERSIBLE_CLASSES.has(actionClass) && guard.irreversibleCap !== undefined;
  const cap = irreversible && guard.irreversibleCap !== undefined ? Math.min(guard.cap, guard.irreversibleCap) : Math.max(0, guard.cap);
  return {
    text: irreversible ? `${cap} · irreversible cap` : String(cap),
    cap,
    irreversible,
  };
}

/** What a mandate's `shadow` value covers: every class, only the listed ones, or nothing. */
export type ShadowMode = boolean | readonly string[] | null | undefined;

export function shadowInfo(shadow: ShadowMode): { full: boolean; classes: string[] } {
  if (shadow === true) return { full: true, classes: [] };
  if (Array.isArray(shadow)) {
    return { full: false, classes: [...new Set(shadow.filter((value): value is string => typeof value === 'string'))] };
  }
  return { full: false, classes: [] };
}

export function shadowApplies(shadow: ShadowMode, actionClass: string): boolean {
  const info = shadowInfo(shadow);
  return info.full || info.classes.includes(actionClass);
}

/** "On for every action class", "Limited to Broadcast sends", or "Off" — never a bare boolean. */
export function shadowText(shadow: ShadowMode): string {
  const info = shadowInfo(shadow);
  if (info.full) return 'On for every action class';
  if (info.classes.length) return `Limited to ${info.classes.map(actionClassLabel).join(', ')}`;
  return 'Off';
}

export function matrixExplanation({
  actionClass,
  granted,
  ceiling,
  guard,
  outsideHours,
  shadow,
}: {
  actionClass: string;
  granted: { level: number; set: boolean };
  ceiling: number | null;
  guard: AgentDetail['guard'];
  outsideHours: string | null;
  shadow: ShadowMode;
}): string {
  const parts: string[] = [];
  if (!granted.set) parts.push('Policy default level 1 (Propose).');
  if (ceiling === null) parts.push('Workspace ceiling unavailable; the granted level is shown without it.');
  else if (granted.level > ceiling) parts.push('Above the workspace ceiling; the ceiling applies.');
  if (guard) {
    const cap = guardianCap(guard, actionClass);
    if (cap.cap !== null && cap.cap < granted.level) parts.push(`The guardian caps this class at level ${cap.cap} until cleared.`);
  }
  if (outsideHours && IRREVERSIBLE_CLASSES.has(actionClass)) {
    parts.push('Outside working hours, irreversible actions are capped at level 2.');
  }
  if (shadowApplies(shadow, actionClass)) {
    parts.push('Shadow mode: decisions are recorded, nothing runs.');
  } else if (shadowInfo(shadow).classes.length) {
    parts.push('Not in shadow mode; the usual approval policy applies.');
  }
  if (!parts.length) {
    parts.push(ceiling !== null && granted.level >= ceiling ? 'At the workspace ceiling.' : 'Within the workspace ceiling.');
  }
  return parts.join(' ');
}

export function mandateScopeText(scope: MandateContent['scope'] | null | undefined): string {
  if (!scope) return 'Everything the levels allow';
  const segments = scope.segments ?? [];
  const purposes = scope.purposes ?? [];
  const topics = scope.topics ?? [];
  const artifactTypes = scope.artifactTypes ?? [];
  const channels = scope.channels ?? [];
  const parts: string[] = [];
  if (segments.length) parts.push(`${segments.length} ${segments.length === 1 ? 'audience' : 'audiences'}`);
  if (purposes.length) parts.push(`${purposes.length} ${purposes.length === 1 ? 'purpose' : 'purposes'}`);
  if (topics.length) parts.push(`${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}`);
  if (artifactTypes.length) {
    parts.push(`${artifactTypes.length} ${artifactTypes.length === 1 ? 'artifact type' : 'artifact types'}`);
  }
  if (channels.length) parts.push(channels.join(', '));
  return parts.length ? parts.join(' · ') : 'Everything the levels allow';
}

export function mandateLimitsText(limits: MandateContent['limits'] | null | undefined): string {
  if (!limits) return 'No extra limits beyond the levels.';
  const parts: string[] = [];
  const number = (value: number) => value.toLocaleString('en-US');
  if (typeof limits.recipientsPerSend === 'number') parts.push(`${number(limits.recipientsPerSend)} recipients per send`);
  if (typeof limits.sendsPerDay === 'number')
    parts.push(`${number(limits.sendsPerDay)} ${limits.sendsPerDay === 1 ? 'send' : 'sends'}/day`);
  if (typeof limits.changesPerDay === 'number') parts.push(`${number(limits.changesPerDay)} changes/day`);
  if (typeof limits.messagesPerDay === 'number') parts.push(`${number(limits.messagesPerDay)} messages/day`);
  if (typeof limits.recipientGrowth === 'number') parts.push(`audience growth ${limits.recipientGrowth}×`);
  return parts.length ? parts.join(' · ') : 'No extra limits beyond the levels.';
}

const DAY_LABEL: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

export function workingHoursText(hours: MandateContent['workingHours'] | null | undefined): string {
  if (!hours?.start || !hours?.end) return 'Any time';
  const days = hours.days?.length ? hours.days.map((day) => DAY_LABEL[day] ?? day).join(', ') : 'Every day';
  return `${days} · ${hours.start}–${hours.end}`;
}

export function blackoutText(dates: string[] | null | undefined): string {
  return dates?.length ? dates.join(', ') : 'None';
}

export function holdWindowText(holdWindow: string | null | undefined): string {
  const match = /^PT(\d+)H$/.exec(holdWindow ?? '');
  if (match) return `${match[1]} ${match[1] === '1' ? 'hour' : 'hours'}`;
  const minutes = /^PT(\d+)M$/.exec(holdWindow ?? '');
  if (minutes) return `${minutes[1]} minutes`;
  return 'Not set';
}

export function measureName(measure: string): string {
  return measureLabel(measure);
}

export function outcomeLaneName(lane: 'broadcasts' | 'direct'): string {
  return lane === 'broadcasts' ? 'Broadcast outcomes · people' : 'Direct outcomes · messages';
}

/** The latest event is never inferred from a fetch time. */
export const LATEST_EVENT_UNAVAILABLE = 'Latest event in period: Unavailable';

export function isNotFound(message: string | null | undefined): boolean {
  return !!message && /not found|not available at this address/i.test(message);
}
