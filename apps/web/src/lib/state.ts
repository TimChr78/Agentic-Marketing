import type { Tone } from '../ui/display';

// Operational state (#437, DESIGN.md v2 → Operational state pills). The state is what is happening
// to the object now; publication version is secondary metadata ("Published v2"). A state that the
// API does not supply is never guessed: callers pass only facts they actually have, and the
// fallback is a neutral publication state rather than a green execution claim.

/** The marker shape shown beside the state text; `dot` is the quiet neutral marker. */
export type OperationalIcon = 'dot' | 'clock' | 'arrow' | 'check' | 'pause' | 'octagon' | 'square' | 'hand';

export interface OperationalState {
  key: string;
  label: string;
  tone: Tone;
  icon: OperationalIcon;
  /** A qualifying sentence for the pill's tooltip or the line below it. */
  detail?: string;
}

/** The publication facts every artifact list/detail read already returns. */
export interface ArtifactStateInput {
  type: string;
  latestState: string;
  latestVersion?: number;
  publishedVersion: number | null;
}

export type BroadcastRunStatus = 'not_scheduled' | 'scheduled' | 'running' | 'done' | 'cancelled' | 'failed' | 'stopped';

/** The run fields `broadcasts.status` returns; no other endpoint carries operational send state. */
export interface BroadcastRunView {
  status: BroadcastRunStatus;
  sendAt?: string | null;
  error?: string | null;
}

export interface BroadcastStageView {
  stage: string;
  stopReason?: string | null;
}

export interface BroadcastStateInput extends ArtifactStateInput {
  run?: BroadcastRunView | null;
  /** Message counts by status from `broadcasts.status` (queued, sending, sent, delivered, failed…). */
  messages?: Record<string, number> | null;
  stage?: BroadcastStageView | null;
  /** Injectable for tests and fixed-clock screenshots. */
  now?: Date;
}

export interface JourneyStateInput extends ArtifactStateInput {
  /** No journey pause/stop flag is stored yet; a caller with such evidence may pass it. */
  paused?: boolean;
  stopped?: boolean;
}

export interface ExperienceStateInput extends ArtifactStateInput {
  paused?: boolean;
}

export interface FormStateInput extends ArtifactStateInput {
  paused?: boolean;
}

export interface AgentStateInput {
  status: 'active' | 'paused' | 'revoked' | string;
  statusReason?: string | null;
  /** `agents.list`/`agents.get` include the guardian cap when it is in force. */
  guard?: { cap?: number; reason?: string | null } | null;
}

const parseDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * A publication state for artifacts without a runtime of their own. When a live version exists and
 * the latest version is a draft or in review, the artifact stays live and the pill says so; the
 * draft is secondary metadata, never an execution claim.
 */
function publicationState(input: ArtifactStateInput, live: { key: string; label: string; icon: OperationalIcon }): OperationalState {
  const { latestState, publishedVersion } = input;
  // A published version keeps serving whatever happens to a newer one, so live wins; the
  // replacement's review, rejection or draft is secondary detail (#442 review).
  if (publishedVersion !== null) {
    const pending =
      latestState === 'in_review'
        ? `A new version is in review; v${publishedVersion} stays live until it is approved.`
        : latestState === 'rejected'
          ? `A newer version was rejected; v${publishedVersion} is still live.`
          : latestState === 'draft'
            ? 'Unpublished changes'
            : undefined;
    return { key: live.key, label: live.label, tone: 'good', icon: live.icon, detail: pending };
  }
  if (latestState === 'rejected') return { key: 'rejected', label: 'Rejected', tone: 'bad', icon: 'octagon' };
  if (latestState === 'in_review') return { key: 'in_review', label: 'In review', tone: 'warn', icon: 'clock' };
  if (latestState === 'superseded') return { key: 'superseded', label: 'Superseded', tone: 'neutral', icon: 'square' };
  if (latestState === 'published') return { key: live.key, label: live.label, tone: 'good', icon: live.icon };
  return { key: 'draft', label: 'Draft', tone: 'neutral', icon: 'dot' };
}

/**
 * Where a broadcast is. The run's own status wins over the publication version because a published
 * broadcast may still be scheduled, sending or stopped. `not_scheduled` and a missing run fall back
 * to the version state.
 *
 * TODO(#437/B1): the list currently reads what `artifacts.list` returns plus one `broadcasts.status`
 * call per visible row. B1 (`broadcasts.list`) replaces that fan-out with one bounded read; this
 * model already accepts the same run/stage fields, so the list only changes its data source.
 */
export function stateOfBroadcast(input: BroadcastStateInput): OperationalState {
  const { run, stage } = input;
  if (run && run.status !== 'not_scheduled') {
    switch (run.status) {
      case 'running':
        return { key: 'sending', label: 'Sending', tone: 'info', icon: 'arrow' };
      case 'done': {
        // `done` means every recipient was processed and its message queued, not that a provider
        // accepted it. Only the message counts can say "sent"; without them the claim is "queued".
        const m = input.messages;
        const n = (k: string) => m?.[k] ?? 0;
        if (!m)
          return {
            key: 'queued',
            label: 'Queued',
            tone: 'info',
            icon: 'clock',
            detail: 'Every recipient was queued; delivery results are not loaded.',
          };
        const pending = n('queued') + n('sending');
        const accepted = n('sent') + n('delivered') + n('bounced') + n('complained');
        if (pending > 0)
          return {
            key: 'delivering',
            label: 'Delivering',
            tone: 'info',
            icon: 'arrow',
            detail: `${pending.toLocaleString('en-US')} messages still waiting for the provider.`,
          };
        if (accepted > 0)
          return {
            key: 'sent',
            label: 'Sent',
            tone: n('failed') > 0 ? 'warn' : 'good',
            icon: 'check',
            detail: n('failed') > 0 ? `${n('failed').toLocaleString('en-US')} messages failed.` : undefined,
          };
        if (n('failed') > 0)
          return { key: 'failed', label: 'Failed', tone: 'bad', icon: 'octagon', detail: 'No message was accepted by the provider.' };
        return {
          key: 'sent_none',
          label: 'Nobody to send to',
          tone: 'neutral',
          icon: 'square',
          detail: 'The run found no eligible recipients.',
        };
      }
      case 'scheduled': {
        const sendAt = parseDate(run.sendAt);
        const now = input.now ?? new Date();
        const overdue = sendAt !== null && sendAt.getTime() <= now.getTime();
        return {
          key: 'scheduled',
          label: 'Scheduled',
          tone: 'info',
          icon: 'clock',
          detail: overdue ? 'The send time has passed; waiting for sending to start.' : undefined,
        };
      }
      case 'stopped':
        return {
          key: 'stopped',
          label: 'Stopped',
          tone: 'bad',
          icon: 'octagon',
          detail: stage?.stopReason ?? run.error ?? 'Stopped at the canary check.',
        };
      case 'failed':
        return { key: 'blocked', label: 'Blocked', tone: 'bad', icon: 'octagon', detail: run.error ?? undefined };
      case 'cancelled':
        return { key: 'cancelled', label: 'Cancelled', tone: 'neutral', icon: 'square', detail: 'No further messages will be sent.' };
      default:
        break;
    }
  }
  return publicationState(input, { key: 'published', label: 'Published', icon: 'check' });
}

/** A journey is live for enrolment while published; an unpublished draft does not stop it. */
export function stateOfJourney(input: JourneyStateInput): OperationalState {
  if (input.stopped) return { key: 'stopped', label: 'Stopped', tone: 'neutral', icon: 'square' };
  if (input.paused) return { key: 'paused', label: 'Paused', tone: 'neutral', icon: 'pause' };
  return publicationState(input, { key: 'live', label: 'Live', icon: 'check' });
}

/** A web experience is live while its published version serves traffic. */
export function stateOfExperience(input: ExperienceStateInput): OperationalState {
  if (input.paused) return { key: 'paused', label: 'Paused', tone: 'neutral', icon: 'pause' };
  return publicationState(input, { key: 'live', label: 'Live', icon: 'check' });
}

/** A form is live while its published version accepts submissions. */
export function stateOfForm(input: FormStateInput): OperationalState {
  if (input.paused) return { key: 'paused', label: 'Paused', tone: 'neutral', icon: 'pause' };
  return publicationState(input, { key: 'live', label: 'Live', icon: 'check' });
}

/**
 * An agent's status, plus a guardian cap when one is in force. `active` is permission to act, not
 * proof that the agent is executing something; `held` means the guardian capped it until a person
 * clears the episode.
 */
export function stateOfAgent(input: AgentStateInput): OperationalState {
  if (input.status === 'revoked')
    return { key: 'revoked', label: 'Revoked', tone: 'bad', icon: 'octagon', detail: input.statusReason ?? undefined };
  if (input.status === 'paused')
    return { key: 'paused', label: 'Paused', tone: 'neutral', icon: 'pause', detail: input.statusReason ?? undefined };
  if (typeof input.guard?.cap === 'number')
    return {
      key: 'held',
      label: 'Held',
      tone: 'warn',
      icon: 'hand',
      detail: input.guard.reason ?? 'The guardian capped this agent until a person clears it.',
    };
  if (input.status === 'active') return { key: 'active', label: 'Active', tone: 'good', icon: 'check' };
  return { key: 'unknown', label: 'Unknown state', tone: 'neutral', icon: 'dot', detail: input.status };
}

/** The family dispatcher used by shared pages. */
export function stateOfArtifact(input: ArtifactStateInput): OperationalState {
  switch (input.type) {
    case 'broadcast':
      return stateOfBroadcast(input);
    case 'journey':
      return stateOfJourney(input);
    case 'experience':
      return stateOfExperience(input);
    case 'form':
      return stateOfForm(input);
    default:
      return publicationState(input, { key: 'published', label: 'Published', icon: 'check' });
  }
}

/**
 * The secondary publication text. "Published v2" is metadata; it never replaces the operational
 * state and never implies that a send or a run succeeded.
 */
export function publicationLabel(input: { latestVersion?: number; publishedVersion: number | null }): string {
  if (input.publishedVersion !== null) return `Published v${input.publishedVersion}`;
  return input.latestVersion !== undefined ? `v${input.latestVersion} · not published` : 'Not published';
}
