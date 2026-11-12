import { Alert, Card, Skeleton } from '../../../ui';
import { getWorkspaceTimeZone } from '../../../ui/time';
import { EmailPreview } from '../../previews/EmailPreview';
import { PreviewLabel } from '../../previews/PreviewLabel';
import type { PreviewSource } from '../../previews/previewSource';
import { AudienceEstimate } from './AudienceEstimate';
import { Checklist } from './Checklist';
import { type ComposerBroadcastContent, scheduleSummary, windowSummary } from './model';
import type { AudienceEstimateView, ComposerData } from './useComposerData';

/**
 * The composer's live preview (#497): unsaved configuration beside a version-pinned template body.
 * The outer label names the broadcast draft; the nested label names the exact template version the
 * server rendered, so a saved body is never shown under an unsaved claim.
 */
export function ComposerPreview({
  content,
  dirty,
  source,
  estimate,
  data,
  savedRevision,
  segmentName,
  segmentLoading,
  topicName,
  onRefreshChecks,
}: {
  content: ComposerBroadcastContent;
  dirty: boolean;
  source: PreviewSource;
  estimate: AudienceEstimateView;
  data: ComposerData;
  savedRevision: string;
  segmentName: string | null;
  /** The segment reference is still being read; "Unavailable" is reserved for a failed or missing read. */
  segmentLoading: boolean;
  topicName: string;
  onRefreshChecks: () => void;
}) {
  const zone = getWorkspaceTimeZone();
  const template = content.template;
  const templateArtifact = data.template.artifact;
  const published = templateArtifact?.publishedVersion ?? null;
  const nestedVersion = templateArtifact ? (published ?? templateArtifact.latestVersion) : undefined;
  const nestedSource: PreviewSource | undefined =
    nestedVersion !== undefined
      ? published
        ? { kind: 'published', version: published }
        : { kind: 'saved', version: nestedVersion }
      : undefined;
  const window = content.sendWindow;

  return (
    <section aria-labelledby="composer-preview-title" className="min-w-0 space-y-4">
      <h2 id="composer-preview-title" className="text-[16px] leading-6 font-semibold">
        Live preview
      </h2>
      <PreviewLabel source={source} />
      {content.description && <p className="text-[13px] leading-5 break-words text-fg-2">{content.description}</p>}
      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-[12px] leading-[18px] sm:grid-cols-2">
        <MetaRow term="Template" value={templateArtifact?.name ?? 'Not set'} />
        <MetaRow
          term="Segment"
          value={segmentName ?? (content.segment ? (segmentLoading ? 'Segment…' : 'Unavailable reference') : 'Not set')}
        />
        <MetaRow term="Topic" value={topicName} />
        <MetaRow term="Time zone" value={`Shown in ${zone}`} />
      </dl>
      <div>
        <p className="text-[13px] leading-5 text-fg">{content.sendAt ? `${scheduleSummary(content)} · ${zone}` : 'On publication'}</p>
        <p className="mt-0.5 text-[12px] leading-[18px] text-muted">
          {window
            ? `${windowSummary(window)}. Readers without a valid zone use the delivery-policy zone.`
            : `Scheduled time shown in ${zone}; arrival time varies.`}
        </p>
      </div>

      <AudienceEstimate estimate={estimate} template={template} segment={content.segment} dirty={dirty} savedRevision={savedRevision} />

      <Checklist
        rows={data.rows}
        onRefresh={onRefreshChecks}
        onRetry={data.retry}
        refreshing={data.refreshing}
        checkedAt={data.checkedAt}
      />

      <section aria-labelledby="composer-message-title" className="space-y-3">
        <h3 id="composer-message-title" className="text-[14px] leading-5 font-semibold">
          The e-mail
        </h3>
        {!template ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">Choose a template to see the e-mail.</p>
        ) : data.channel !== 'email' ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">
            SMS and push templates are not rendered in this preview. The broadcast still sends the selected template.
          </p>
        ) : data.template.loading ? (
          <Skeleton className="h-40" />
        ) : data.template.error ? (
          <Alert tone="bad" title="Couldn’t load the template" onRetry={data.template.reload}>
            {data.template.error}
          </Alert>
        ) : nestedVersion !== undefined && nestedSource ? (
          <EmailPreview
            artifactId={template}
            version={nestedVersion}
            source={nestedSource}
            sourceSuffix={published ? 'template' : 'template · not live'}
            compact
          />
        ) : (
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">
            The template has no saved version to render.
          </p>
        )}
      </section>

      {content.subjectTest && data.channel === 'email' && (
        <Card
          title="Subject test"
          description={`${content.subjectTest.samplePercent}% of the audience gets one of ${content.subjectTest.subjects.length} subjects; after ${content.subjectTest.decideAfter} the winner by ${content.subjectTest.metric === 'click' ? 'clicks' : 'opens'} goes to the rest. The template subject is unchanged.`}
        >
          <div className="space-y-1.5 p-4">
            {content.subjectTest.subjects.map((subject, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: subject lines are plain strings with no id; their position is their identity
              <div key={i} className="flex gap-2 text-[13px] leading-5">
                <span className="w-4 shrink-0 text-muted">{String.fromCharCode(65 + i)}</span>
                <span className="min-w-0 break-words text-fg-2">{subject || <span className="text-muted">(empty)</span>}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

function MetaRow({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-muted">{term}</dt>
      <dd className="min-w-0 break-words text-fg-2">{value}</dd>
    </div>
  );
}
