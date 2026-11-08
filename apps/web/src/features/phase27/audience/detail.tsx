import { Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonLink } from '../../../app/links';
import { publicationLabel } from '../../../lib/state';
import { Button, timeAgo } from '../../../ui';
import { Identifier } from '../../../ui/Identifier';
import type {
  Artifact,
  ArtifactDetailActionContext,
  ArtifactDetailActionSlots,
  ArtifactDetailView,
} from '../../artifacts/ArtifactDetailPage';

// The shared detail pieces for the audience and marketing families (#525): the metadata line, the
// one primary action chosen by runtime state, and the family context panels. None of these reads
// anything; a context panel renders the artifact already in hand plus its unsaved draft.

export function audienceMetadata(a: Artifact) {
  return (
    <>
      <span>{publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}</span>
      <span>
        v{a.version.number} by {a.version.by?.displayName ?? (a.version.author.type === 'agent' ? 'an agent' : 'a person')}
      </span>
      <span>{timeAgo(a.version.createdAt)}</span>
      <Identifier value={a.id} label="Identifier" />
    </>
  );
}

/**
 * The detail template's one primary action. Saving wins while there are unsaved changes; otherwise
 * the existing publish gate or the pending review decides. A failed pending-approval read blocks
 * publishing and offers its own retry rather than acting on an unknown state.
 */
export function audienceActions(ctx: ArtifactDetailActionContext): ArtifactDetailActionSlots {
  if (ctx.dirty && !ctx.readOnly) {
    return {
      primary: (
        <Button variant="primary" loading={ctx.saving} onClick={() => void ctx.save()}>
          Save draft
        </Button>
      ),
      secondary: (
        <Button variant="ghost" onClick={ctx.resetToSaved}>
          Discard changes
        </Button>
      ),
    };
  }
  if (ctx.pending) {
    return {
      primary: (
        <ButtonLink to={`/approvals/${ctx.pending.id}`} variant={ctx.canApprove ? 'primary' : 'secondary'}>
          {ctx.canApprove ? 'Review the request' : 'View the approval request'}
        </ButtonLink>
      ),
    };
  }
  const pendingUnknown = !!ctx.pendingRead && (ctx.pendingRead.loading || !!ctx.pendingRead.error);
  if (ctx.canPublish && !pendingUnknown) {
    return {
      primary: (
        <Button variant="primary" icon={<Send size={14} />} onClick={ctx.openPublish}>
          {ctx.directPublish ? 'Publish' : 'Submit for review'}
        </Button>
      ),
    };
  }
  if (ctx.canPublish && ctx.pendingRead?.error) {
    return {
      primary: null,
      secondary: (
        <Button variant="secondary" onClick={() => void ctx.pendingRead?.reload()}>
          Retry approval check
        </Button>
      ),
    };
  }
  return { primary: null };
}

/** The consequence inset above the tabs: what publishing does, in the family's own terms. */
export function ConsequenceInset({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-surface-2 px-4 py-3 text-[13px] leading-5 text-fg-2">{children}</div>;
}

function draftContent<T>(artifact: Artifact, view: ArtifactDetailView): T {
  return (view.draft ?? artifact.version.content) as T;
}

interface FormPreviewContent {
  consentText?: string;
  traits?: string[];
  doubleOptIn?: boolean;
  confirmationTemplate?: string;
  purposes?: string[];
  [key: string]: unknown;
}

function PreviewField({ label }: { label: string }) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-fg-2">{label}</div>
      <div className="h-8 rounded-md border border-control bg-surface" />
    </div>
  );
}

/** The signup form as visitors see it, rendered from the unsaved draft with no extra read. */
export function FormPreviewAside({ artifact, view }: { artifact: Artifact; view: ArtifactDetailView }) {
  const content = draftContent<FormPreviewContent>(artifact, view);
  const traits = content.traits ?? ['firstName'];
  return (
    <div className="space-y-3">
      <h2 className="text-[13px] font-medium text-fg">Preview</h2>
      <p className="text-[12px] leading-[18px] text-muted">
        {view.dirty ? 'Unsaved draft preview' : `Saved v${artifact.version.number} preview`}
      </p>
      <section className="rounded-lg border border-line bg-surface p-4" aria-label="Form preview">
        <div aria-hidden className="space-y-3">
          <PreviewField label="E-mail" />
          {traits.map((trait) => (
            <PreviewField key={trait} label={trait} />
          ))}
          <div className="flex items-start gap-2">
            <span className="mt-0.5 size-4 shrink-0 rounded-sm border border-control" />
            <p className="text-[13px] whitespace-pre-wrap text-fg">
              {content.consentText || <span className="text-bad">No consent text</span>}
            </p>
          </div>
          <div className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg">Subscribe</div>
        </div>
        <p className="mt-3 text-[12px] leading-[18px] text-muted">
          {content.doubleOptIn === false
            ? 'Consent counts as soon as the form is submitted.'
            : 'Double opt-in asks the person to confirm by e-mail before consent counts.'}
        </p>
      </section>
      {content.doubleOptIn !== false && !content.confirmationTemplate && (
        <p className="text-[12px] leading-[18px] text-warn">Choose a published confirmation e-mail before publishing this form.</p>
      )}
    </div>
  );
}

interface SegmentViewContent {
  description?: string;
  mode?: 'dynamic' | 'static' | 'snapshot';
  sourceSegment?: string;
  snapshotVersion?: number;
  snapshotAt?: string;
  [key: string]: unknown;
}

/** What the audience means and when it applies, without a second list or member read. */
export function SegmentContextAside({ artifact, view }: { artifact: Artifact; view: ArtifactDetailView }) {
  const content = draftContent<SegmentViewContent>(artifact, view);
  const mode = content.mode ?? 'dynamic';
  return (
    <div className="space-y-3">
      <h2 className="text-[13px] font-medium text-fg">Before publishing</h2>
      <p className="text-[13px] leading-5 text-fg-2">
        {mode === 'dynamic'
          ? 'The rules are evaluated whenever the audience is used. Saving keeps a draft; publishing makes the new rules live.'
          : mode === 'snapshot'
            ? 'The members are a frozen copy of another segment and stay fixed until someone refreshes them.'
            : 'The members are an explicit list, changed by hand, CSV or API. A segment refresh never changes it.'}
      </p>
      {mode === 'snapshot' && (
        <p className="text-[12px] leading-[18px] text-muted">
          Copied
          {content.snapshotVersion ? ` at v${content.snapshotVersion}` : ''}
          {content.snapshotAt ? ` on ${new Date(content.snapshotAt).toLocaleString()}` : ''}. Refreshing changes the members, not the saved
          rules.
        </p>
      )}
      <p className="text-[12px] leading-[18px] text-muted">
        Membership is not consent. Sends still check each person’s choices, suppression and the delivery policy.
      </p>
      {view.dirty && <p className="text-[12px] leading-[18px] text-warn">Unsaved changes are not in the published version.</p>}
    </div>
  );
}

interface ExperienceViewContent {
  placement?: string;
  trigger?: { type?: string; value?: number };
  variants?: { id?: string; name?: string; weight?: number }[];
  holdoutPercent?: number;
  goal?: { event?: string };
  [key: string]: unknown;
}

const TRIGGER_WORDS: Record<string, string> = {
  immediate: 'at once, when the placement appears',
  exit_intent: 'when the visitor is about to leave',
  scroll: 'after scrolling a share of the page',
  time_on_page: 'after a time on the page',
};

/** The experiment as configured: what shows, how traffic splits and what counts as success. */
export function ExperienceContextAside({ artifact, view }: { artifact: Artifact; view: ArtifactDetailView }) {
  const content = draftContent<ExperienceViewContent>(artifact, view);
  const variants = content.variants ?? [];
  const total = variants.reduce((sum, variant) => sum + (Number(variant.weight) || 0), 0);
  const trigger = content.trigger ?? { type: 'immediate' };
  const triggerWords = TRIGGER_WORDS[trigger.type ?? 'immediate'] ?? trigger.type;
  return (
    <div className="space-y-3">
      <h2 className="text-[13px] font-medium text-fg">Before publishing</h2>
      <dl className="grid grid-cols-[minmax(88px,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px] leading-[18px]">
        <dt className="text-muted">Placement</dt>
        <dd className="text-fg">{content.placement || 'Not set'}</dd>
        <dt className="text-muted">Trigger</dt>
        <dd className="text-fg">
          {triggerWords}
          {trigger.value !== undefined ? ` (${trigger.value}${trigger.type === 'scroll' ? '%' : ' seconds'})` : ''}
        </dd>
        <dt className="text-muted">Variants</dt>
        <dd className="text-fg">
          {variants.length} · weights total {total}%
        </dd>
        <dt className="text-muted">Holdout</dt>
        <dd className="text-fg">{content.holdoutPercent ?? 0}% see nothing</dd>
        <dt className="text-muted">Goal</dt>
        <dd className="text-fg">{content.goal?.event ?? 'No goal set'}</dd>
      </dl>
      <p className="text-[12px] leading-[18px] text-muted">
        Results count real exposures and conversions. Previews and design examples are never counted.
      </p>
      {view.dirty && <p className="text-[12px] leading-[18px] text-warn">Unsaved changes are not in the published version.</p>}
    </div>
  );
}
