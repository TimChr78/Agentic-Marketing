import type { Out } from '../../app/api';
import { type BroadcastRunStatus, type OperationalState, publicationLabel, stateOfBroadcast } from '../../lib/state';
import { formatDateTime } from '../../ui/time';

// Broadcast list projections (#448). Everything here is pure: the list page maps one
// `broadcasts.list` row to the row's state, subtitle, audience, schedule and result, and the tests
// exercise each operational state without an API. The state itself comes from `stateOfBroadcast`,
// never from a local heuristic.

export type BroadcastListRow = Out<'broadcasts.list'>['broadcasts'][number];

export interface BroadcastStatusFilter {
  key: string;
  label: string;
  /** The `?status=` value; null means every status. */
  param: string | null;
  statuses?: BroadcastRunStatus[];
}

/** Filter choices and order exactly as the Phase 24 contract fixes them. */
export const BROADCAST_STATUS_FILTERS: BroadcastStatusFilter[] = [
  { key: 'all', label: 'All statuses', param: null },
  { key: 'active', label: 'Scheduled and sending', param: 'active', statuses: ['scheduled', 'running'] },
  { key: 'scheduled', label: 'Scheduled', param: 'scheduled', statuses: ['scheduled'] },
  { key: 'running', label: 'Sending', param: 'running', statuses: ['running'] },
  { key: 'done', label: 'Finished preparation', param: 'done', statuses: ['done'] },
  { key: 'stopped', label: 'Stopped', param: 'stopped', statuses: ['stopped'] },
  { key: 'failed', label: 'Failed', param: 'failed', statuses: ['failed'] },
  { key: 'cancelled', label: 'Cancelled', param: 'cancelled', statuses: ['cancelled'] },
  { key: 'not_scheduled', label: 'Not scheduled', param: 'not_scheduled', statuses: ['not_scheduled'] },
];

export function filterForParam(param: string | null): { filter: BroadcastStatusFilter; unknown: boolean } {
  if (!param) return { filter: BROADCAST_STATUS_FILTERS[0]!, unknown: false };
  const filter = BROADCAST_STATUS_FILTERS.find((f) => f.param === param);
  return filter ? { filter, unknown: false } : { filter: BROADCAST_STATUS_FILTERS[0]!, unknown: true };
}

/** The operational pill of one row, from the foundation's state model. */
export function broadcastStateOf(row: BroadcastListRow, now?: Date): OperationalState {
  return stateOfBroadcast({
    type: 'broadcast',
    latestState: row.latestState,
    latestVersion: row.latestVersion,
    publishedVersion: row.publishedVersion,
    run: row.run,
    stage: row.stage,
    delivery: row.delivery,
    ...(now ? { now } : {}),
  });
}

/**
 * The second line under the name: publication metadata, or the draft that differs from the run
 * that is sending. The runtime state stays in the pill; this line never replaces it.
 */
export function broadcastSubtitleOf(row: BroadcastListRow): string {
  const run = row.run;
  if (run && run.status !== 'not_scheduled' && run.version !== null && row.latestVersion > run.version) {
    const sending = run.status === 'running';
    if (row.latestState === 'in_review') return `v${row.latestVersion} in review`;
    if (row.latestState === 'draft') return `${sending ? 'Sending ' : ''}v${run.version} · draft v${row.latestVersion}`;
    if (row.latestState === 'rejected') return `${sending ? 'Sending ' : ''}v${run.version} · v${row.latestVersion} rejected`;
  }
  return publicationLabel({ latestVersion: row.latestVersion, publishedVersion: row.publishedVersion });
}

/** The segment line under the name: who the send reached when it was prepared. */
export function broadcastAudienceOf(row: BroadcastListRow, segmentName: string | null | undefined): { name: string; detail?: string } {
  const name = segmentName ?? 'Segment';
  if (!row.run || row.run.status === 'not_scheduled') return { name, detail: 'Eligibility checked on review' };
  if (row.run.recipients > 0) return { name, detail: `${row.run.recipients.toLocaleString('en-US')} reached at preparation` };
  return { name };
}

const parseDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** The schedule cell: the run's own times, never a fabricated "On publication" on the list. */
export function broadcastScheduleOf(row: BroadcastListRow, now = new Date()): { lines: string[] } {
  const run = row.run;
  if (!run || run.status === 'not_scheduled') return { lines: ['Not scheduled'] };
  if (run.status === 'scheduled') {
    const sendAt = parseDate(run.sendAt);
    const lines = [sendAt ? formatDateTime(run.sendAt, { zone: true }) : 'Not scheduled'];
    if (sendAt && sendAt.getTime() <= now.getTime()) lines.push('Waiting to start');
    return { lines };
  }
  if (run.status === 'running') {
    return { lines: [run.startedAt ? `Started ${formatDateTime(run.startedAt, { zone: true })}` : 'Sending'] };
  }
  if (run.status === 'done') {
    return { lines: [run.finishedAt ? `Finished ${formatDateTime(run.finishedAt, { zone: true })}` : 'Finished'] };
  }
  // stopped / failed / cancelled: the run started; keep its start visible with the reason in Result.
  return { lines: [run.startedAt ? `Started ${formatDateTime(run.startedAt, { zone: true })}` : 'Not started'] };
}

export interface BroadcastResult {
  lines: string[];
  /** Warn when some messages failed or the send was held back; the state pill owns the tone otherwise. */
  tone?: 'warn';
}

/**
 * The result cell. Counts are messages by their current status: provider-accepted is
 * sent+delivered+bounced+complained, awaiting is queued+sending, and failed/suppressed stay
 * separate. A stopped or failed send keeps its cumulative preparation count and its safe reason,
 * never an unsupported "0 sent".
 */
export function broadcastResultOf(row: BroadcastListRow, state = broadcastStateOf(row)): BroadcastResult {
  const run = row.run;
  if (!run || run.status === 'not_scheduled' || run.status === 'scheduled') return { lines: ['Not started'] };
  const n = (key: string) => row.delivery?.[key] ?? 0;
  if (run.status === 'running') {
    const lines = [`${run.queued.toLocaleString('en-US')} queued during preparation`];
    if (run.skipped > 0) lines.push(`${run.skipped.toLocaleString('en-US')} skipped`);
    if (run.windowSkipped > 0) lines.push(`${run.windowSkipped.toLocaleString('en-US')} outside the send window`);
    return { lines };
  }
  if (run.status === 'done') {
    if (!row.delivery) {
      const lines = ['Delivery unavailable'];
      if (run.queued > 0) lines.push(`${run.queued.toLocaleString('en-US')} queued during preparation`);
      return { lines };
    }
    const accepted = n('sent') + n('delivered') + n('bounced') + n('complained');
    const pending = n('queued') + n('sending');
    const failed = n('failed');
    const suppressed = n('suppressed');
    const lines: string[] = [];
    if (accepted > 0) lines.push(`${accepted.toLocaleString('en-US')} provider-accepted`);
    if (pending > 0) lines.push(`${pending.toLocaleString('en-US')} awaiting provider`);
    if (failed > 0) lines.push(`${failed.toLocaleString('en-US')} failed`);
    if (suppressed > 0) lines.push(`${suppressed.toLocaleString('en-US')} suppressed`);
    if (!lines.length) lines.push('No messages');
    return { lines, ...(failed > 0 ? { tone: 'warn' as const } : {}) };
  }
  const lines: string[] = [];
  if (run.queued > 0) lines.push(`${run.queued.toLocaleString('en-US')} queued during preparation`);
  const reason = row.stage?.stopReason ?? run.error ?? state.detail;
  if (reason) lines.push(reason);
  return { lines: lines.length ? lines : ['Not started'], ...(state.tone === 'bad' ? { tone: 'warn' as const } : {}) };
}

/** The count label at the right of the filter row. */
export function broadcastCountLabel(total: number): string {
  return `${total.toLocaleString('en-US')} ${total === 1 ? 'broadcast' : 'broadcasts'}`;
}
