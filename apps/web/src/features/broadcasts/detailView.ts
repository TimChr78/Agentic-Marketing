import type { Out } from '../../app/api';
import { type OperationalState, stateOfBroadcast } from '../../lib/state';
import { formatDateTime } from '../../ui/time';

// Broadcast detail projections (#448). The page keeps one `broadcasts.status` response and these
// pure functions turn it into the pill, the who/when/next summary and the single primary action.
// The tests exercise every runtime and draft state without an API.

export type BroadcastDetailArtifact = Out<'artifacts.get'>;
export type BroadcastStatusData = Out<'broadcasts.status'>;
export type BroadcastRun = BroadcastStatusData['run'];
export type BroadcastStage = Pick<NonNullable<BroadcastStatusData['stage']>, 'stage' | 'stopReason'>;

export interface BroadcastContent {
  template?: string;
  segment?: string;
  sendAt?: string;
}

export const BROADCAST_TABS = ['content', 'preview', 'sending', 'report', 'versions', 'activity'] as const;
export type BroadcastTab = (typeof BROADCAST_TABS)[number];

export function isBroadcastTab(value: string | null | undefined): value is BroadcastTab {
  return !!value && (BROADCAST_TABS as readonly string[]).includes(value);
}

/** The default tab from the runtime state only; an explicit `?tab=` always wins at the call site. */
export function defaultBroadcastTab(status: BroadcastStatusData | undefined): BroadcastTab {
  const run = status?.run.status;
  if (run === 'scheduled' || run === 'running' || run === 'stopped' || run === 'failed') return 'sending';
  if (run === 'done' || run === 'cancelled') return 'report';
  return 'content';
}

export interface BroadcastStateInput {
  artifact: BroadcastDetailArtifact;
  run?: BroadcastRun | null;
  stage?: BroadcastStage | null;
  delivery?: Record<string, number> | null;
  statusError?: string | null;
  now?: Date;
}

/** The detail pill: the shared broadcast state, or an explicit unavailable state when status failed. */
export function broadcastDetailStateOf(input: BroadcastStateInput): OperationalState {
  if (input.statusError)
    return { key: 'unknown', label: 'Send state unavailable', tone: 'neutral', icon: 'dot', detail: input.statusError };
  return stateOfBroadcast({
    type: 'broadcast',
    latestState: input.artifact.version.state,
    latestVersion: input.artifact.latestVersion,
    publishedVersion: input.artifact.publishedVersion,
    run: input.run ?? null,
    stage: input.stage ?? null,
    delivery: input.delivery ?? null,
    ...(input.now ? { now: input.now } : {}),
  });
}

export interface BroadcastConsequence {
  who: string;
  when: string;
  /** The latest draft's audience and template when they differ from the run's pinned ones. */
  draft: string | null;
  next: string;
}

export interface ConsequenceInput extends BroadcastStateInput {
  dirty?: boolean;
  draft?: unknown;
  segmentName?: string | null;
  templateName?: string | null;
  /** The names of the segment and template the run is pinned to (status.segmentId/templateId). */
  runSegmentName?: string | null;
  runTemplateName?: string | null;
  /** The latest saved or unsaved draft's segment and template names, labelled separately. */
  draftSegmentName?: string | null;
  draftTemplateName?: string | null;
  /** Whether a pending approval request was found for the artifact. */
  hasPending?: boolean;
  /** Why the pending-approval read failed, when it did. */
  pendingReadError?: string | null;
}

const contentOf = (value: unknown): BroadcastContent => (value && typeof value === 'object' ? (value as BroadcastContent) : {});

const count = (n: number) => n.toLocaleString('en-US');

/** Who, when and next, in that order, from the shared status and saved or unsaved content. */
export function broadcastConsequenceOf(input: ConsequenceInput): BroadcastConsequence {
  const run = input.run ?? null;
  const state = broadcastDetailStateOf(input);
  const runStarted = !!run && run.status !== 'not_scheduled';
  // While a run exists, who it reaches comes from the run's pinned version, never from a later
  // draft that targets another segment (#449 review).
  // An unresolved pinned name stays unresolved: the draft's segment may be a different audience.
  const segment = runStarted ? (input.runSegmentName ?? 'Segment unavailable') : (input.segmentName ?? 'Segment');
  const who =
    runStarted && run && run.recipients > 0
      ? `${segment} · ${count(run.recipients)} reached at preparation`
      : `${segment} · Eligibility not checked`;

  const saved = contentOf(input.artifact.version.content);
  const draft = input.dirty ? contentOf(input.draft) : saved;
  let when: string;
  if (runStarted && run?.sendAt) when = formatDateTime(run.sendAt, { zone: true });
  else if (input.dirty)
    when = draft.sendAt ? `Unsaved draft · ${formatDateTime(draft.sendAt, { zone: true })}` : 'Unsaved draft · On publication';
  else if (saved.sendAt) when = `Saved schedule: ${formatDateTime(saved.sendAt, { zone: true })}`;
  else when = 'On publication';

  // A draft that differs from the pinned run is a separate reference, not the live audience.
  let draftLine: string | null = null;
  if (runStarted && run && (input.dirty || (run.version !== null && input.artifact.latestVersion > run.version))) {
    const label = input.dirty ? 'Unsaved draft' : `Draft v${input.artifact.latestVersion}`;
    const draftSegment = input.dirty ? (input.draftSegmentName ?? 'Segment') : (input.draftSegmentName ?? input.segmentName ?? 'Segment');
    const draftTemplate = input.dirty ? input.draftTemplateName : (input.draftTemplateName ?? input.templateName);
    draftLine = `${label} targets ${draftSegment}${draftTemplate ? ` · ${draftTemplate}` : ''}`;
  }

  let next: string;
  if (input.statusError) {
    next = 'Retry sending status to inspect progress.';
  } else {
    switch (state.key) {
      case 'draft':
        next = input.dirty ? 'Save the draft, then submit it for review.' : 'Submit it for review when the content is ready.';
        break;
      case 'rejected':
        next = 'Fix the rejected content and submit it again.';
        break;
      case 'in_review':
        next = input.pendingReadError
          ? 'Couldn’t check the pending approval request. Retry to load it.'
          : input.hasPending
            ? 'Waiting for a reviewer to decide.'
            : 'No pending request was found. Check Activity for the review history.';
        break;
      case 'scheduled': {
        const sendAt = run?.sendAt ? new Date(run.sendAt) : null;
        const overdue = sendAt !== null && !Number.isNaN(sendAt.getTime()) && sendAt.getTime() <= (input.now ?? new Date()).getTime();
        next = overdue
          ? 'Send time passed; waiting to start.'
          : sendAt
            ? `Starts ${formatDateTime(run?.sendAt, { zone: true })}.`
            : 'Waiting for the scheduled run.';
        break;
      }
      case 'sending':
      case 'delivering':
      case 'queued': {
        const pending = (input.delivery?.queued ?? 0) + (input.delivery?.sending ?? 0);
        next =
          pending > 0
            ? `${count(pending)} messages still waiting for the provider. Inspect sending progress.`
            : 'Sending is in progress. Inspect sending progress.';
        break;
      }
      case 'stopped': {
        const reason = input.stage?.stopReason ?? run?.error ?? 'The canary check stopped this send.';
        next = `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Review the canary before sending the rest.`;
        break;
      }
      case 'blocked': {
        const reason = run?.error ?? 'The send failed.';
        next = `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Inspect the failure before making changes.`;
        break;
      }
      case 'sent':
        next = state.detail
          ? `${state.detail} View the report for the full outcome.`
          : 'The provider accepted the messages. View the report for the outcome.';
        break;
      case 'suppressed':
      case 'sent_none':
        next = `${state.detail ?? 'Nothing was sent.'} View the report for the delivery outcome.`;
        break;
      case 'cancelled':
        next = 'No further messages will be sent. Messages already sent cannot be recalled.';
        break;
      case 'published':
        next = 'Waiting for the scheduled run.';
        break;
      default:
        next = 'View the content for the saved version.';
        break;
    }
  }
  return { who, when, draft: draftLine, next };
}

export type BroadcastPrimaryAction =
  | { kind: 'save'; label: 'Save draft' }
  | { kind: 'publish'; label: string }
  | { kind: 'tab'; tab: BroadcastTab; label: string }
  | { kind: 'link'; to: string; label: string }
  | { kind: 'retry'; label: 'Retry status' }
  | { kind: 'none'; label: '' };

export interface PrimaryActionInput {
  artifact: BroadcastDetailArtifact;
  run?: BroadcastRun | null;
  statusError?: string | null;
  dirty?: boolean;
  readOnly?: boolean;
  /** artifacts:publish and a saved draft or rejected version. */
  canSubmit?: boolean;
  directPublish?: boolean;
  canApprove?: boolean;
  pendingId?: string | null;
}

/**
 * Exactly one primary action. The runtime state is chosen before the latest draft state: a live
 * run keeps its inspection action, and only a broadcast with no run falls back to save, submit or
 * review. Navigation actions are tabs, not new mutations.
 */
export function broadcastPrimaryActionOf(input: PrimaryActionInput): BroadcastPrimaryAction {
  if (input.statusError) return { kind: 'retry', label: 'Retry status' };
  const run = input.run;
  if (run && run.status !== 'not_scheduled') {
    switch (run.status) {
      case 'scheduled':
      case 'running':
        return { kind: 'tab', tab: 'sending', label: 'View sending' };
      case 'stopped':
        return { kind: 'tab', tab: 'sending', label: 'Inspect canary' };
      case 'failed':
        return { kind: 'tab', tab: 'sending', label: 'Inspect failure' };
      case 'done':
      case 'cancelled':
        return { kind: 'tab', tab: 'report', label: 'View report' };
      default:
        break;
    }
  }

  if (input.dirty && !input.readOnly) return { kind: 'save', label: 'Save draft' };
  const state = input.artifact.version.state;
  if (state === 'draft' || state === 'rejected') {
    if (input.readOnly) return { kind: 'tab', tab: 'content', label: 'View content' };
    if (input.canSubmit)
      return {
        kind: 'publish',
        label: input.directPublish ? `Publish v${input.artifact.latestVersion}` : 'Submit for review',
      };
    return { kind: 'tab', tab: 'content', label: 'View content' };
  }
  if (state === 'in_review') {
    if (input.pendingId)
      return {
        kind: 'link',
        to: `/approvals/${input.pendingId}`,
        label: input.canApprove ? 'Review request' : 'View request',
      };
    return { kind: 'tab', tab: 'activity', label: 'View activity' };
  }
  if (state === 'published') return { kind: 'tab', tab: 'sending', label: 'View sending' };
  return { kind: 'tab', tab: 'content', label: 'View content' };
}
