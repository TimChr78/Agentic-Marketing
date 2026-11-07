import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { Alert, Card, JsonView, LoadingBlock, Meta, Skeleton } from '../../ui';
import { formatDateTime, getWorkspaceTimeZone } from '../../ui/time';
import { useArtifactRef } from '../artifactCache';
import { type BlockGuard, BundledBlocks } from './BundledBlocks';
import { EmailPreview } from './EmailPreview';
import { RefName } from './FormPreview';
import { PreviewLabel } from './PreviewLabel';
import { useSharedRead } from './previewRead';
import type { PreviewSource } from './previewSource';
import { type PreviewStatus, useReportPreviewStatus } from './previewStatus';

const skipText: Record<string, string> = {
  no_consent: 'No consent for the purpose',
  suppressed: 'Suppressed (bounced or complained)',
  unsubscribed: 'Unsubscribed',
  no_email: 'No e-mail address',
  frequency_cap: 'Over the frequency cap',
};

/**
 * A broadcast (#41): template, segment, who would get it now, and when it sends. `templateVersion`
 * is the template version reviewed in the same approval bundle (#107), shown instead of the live one.
 */
export function BroadcastPreview({
  artifactId,
  version,
  content,
  templateVersion,
  blockGuard,
  source,
  sourceSuffix,
  eligibility = 'load',
  reportId = 'artifact',
}: {
  artifactId: string;
  version?: number;
  content: {
    template?: string;
    segment?: string;
    sendAt?: string;
    description?: string;
    subjectTest?: { subjects: string[]; samplePercent: number; metric: 'click' | 'open'; decideAfter: string };
    sendWindow?: { start: string; end: string; days?: string[]; maxDelay?: string };
  };
  templateVersion?: number;
  /** Block pins for the nested template, resolved by the review; the combined render must honor them. */
  blockGuard?: BlockGuard;
  source?: PreviewSource;
  sourceSuffix?: string;
  /** `save-required` skips the saved-version audience read for an unsaved broadcast. */
  eligibility?: 'load' | 'save-required';
  /** Which readiness slot this renderer reports to the Review panel. */
  reportId?: string;
}) {
  const { can } = useSession();
  const skip = !can('artifacts:read') || eligibility === 'save-required';
  const reach = useSharedRead(
    'broadcasts.preview',
    { artifactId, version, templateVersion },
    () => api.call('broadcasts.preview', { artifactId, version, templateVersion }),
    { skip },
  );
  const tpl = useArtifactRef(content.template);
  const isEmail = content.template?.startsWith('eml_');
  const nestedSource: PreviewSource | undefined = templateVersion
    ? { kind: 'saved', version: templateVersion }
    : tpl.artifact?.publishedVersion
      ? { kind: 'published', version: tpl.artifact.publishedVersion }
      : undefined;
  const guardLoading = !!blockGuard?.loading;
  const guardFailed = !!blockGuard && (!!blockGuard.error || blockGuard.unavailable);
  const guardWithheld = !!blockGuard && (guardLoading || !blockGuard.reproducible);
  const status: PreviewStatus = skip
    ? 'ready'
    : reach.loading
      ? 'loading'
      : reach.error
        ? 'error'
        : isEmail && content.template
          ? guardLoading
            ? 'loading'
            : guardFailed
              ? 'error'
              : tpl.error
                ? 'error'
                : tpl.artifact
                  ? 'ready'
                  : 'loading'
          : 'ready';
  useReportPreviewStatus(reportId, status);
  return (
    <div className="space-y-4">
      {source && <PreviewLabel source={source} suffix={sourceSuffix} />}
      {content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Would receive it now">
          {eligibility === 'save-required' ? (
            <span className="text-[13px] text-muted">Save the draft to estimate</span>
          ) : reach.loading ? (
            <Skeleton className="h-5 w-16" />
          ) : reach.error ? (
            <span className="text-[13px] text-bad">{reach.error}</span>
          ) : (
            reach.data?.wouldSend.toLocaleString()
          )}
        </Stat>
        <Stat label="In the segment">
          {eligibility === 'save-required' ? (
            <span className="text-[13px] text-muted">Save the draft to estimate</span>
          ) : reach.loading ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            (reach.data?.audience.toLocaleString() ?? '—')
          )}
        </Stat>
        <Stat label="Sends">
          <span className="text-[14px]">
            {content.sendAt ? formatDateTime(content.sendAt, { zone: true }) : 'As soon as it is approved'}
          </span>
        </Stat>
      </div>
      {reach.data && Object.keys(reach.data.wouldSkip).length > 0 && (
        <Alert tone="info" title="Skipped at send time">
          <ul>
            {Object.entries(reach.data.wouldSkip).map(([k, n]) => (
              <li key={k}>
                {skipText[k] ?? k.replace(/_/g, ' ')}: {n.toLocaleString()}
              </li>
            ))}
          </ul>
          {reach.data.checked < reach.data.audience && (
            <p className="mt-1">Estimated from {reach.data.checked.toLocaleString()} people checked.</p>
          )}
        </Alert>
      )}
      {content.sendWindow && (
        <p className="text-[13px] text-fg-2">
          Sends between {content.sendWindow.start} and {content.sendWindow.end} in each reader’s time zone
          {content.sendWindow.days?.length ? `, on ${content.sendWindow.days.join(', ')}` : ', every day'}. Anyone outside it waits for the
          next opening; those whose next opening is more than {content.sendWindow.maxDelay ?? 'P1D'} after the send time are skipped.
        </p>
      )}
      {content.subjectTest && (
        <Card
          title="Subject test"
          description={`${content.subjectTest.samplePercent}% of the audience gets one of ${content.subjectTest.subjects.length} subjects; after ${content.subjectTest.decideAfter} the winner by ${content.subjectTest.metric === 'click' ? 'clicks' : 'opens'} goes to the rest.`}
        >
          <div className="space-y-1.5 p-4">
            {content.subjectTest.subjects.map((subject, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: subject lines are plain strings with no id; position is their identity
              <div key={i} className="flex gap-2 text-[13px]">
                <span className="w-4 shrink-0 text-muted">{String.fromCharCode(65 + i)}</span>
                <span className="min-w-0 break-words text-fg-2">{subject || <span className="text-muted">(empty)</span>}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <div className="p-4">
          <Meta
            items={[
              ['Template', <RefName key="template" id={content.template} />],
              ['Segment', <RefName key="segment" id={content.segment} />],
              ['Time zone', `Shown in ${getWorkspaceTimeZone()}`],
            ]}
          />
        </div>
      </Card>
      {isEmail && content.template && (
        <Card
          title="The e-mail"
          description={
            templateVersion
              ? `Version v${templateVersion} of the template, reviewed together with this broadcast`
              : tpl.artifact?.publishedVersion
                ? `Live version v${tpl.artifact.publishedVersion} of the template`
                : 'The template is not published yet; showing its latest draft'
          }
        >
          <div className="p-4">
            {guardWithheld ? (
              guardLoading ? (
                <LoadingBlock lines={4} label="Resolving reusable blocks" />
              ) : (
                <div className="space-y-3">
                  <Alert
                    tone={blockGuard?.error ? 'bad' : 'warn'}
                    title={
                      blockGuard?.error
                        ? 'Couldn’t read this template’s reusable blocks'
                        : 'Bundled block render unavailable before publication'
                    }
                    {...(blockGuard?.error ? { onRetry: blockGuard.onRetry } : {})}
                  >
                    {blockGuard?.error
                      ? 'The combined message is withheld until every reusable block can be resolved. The exact reviewed content is shown below.'
                      : 'The server expands each block at its published version, so it cannot render this bundle’s block pins. The exact reviewed content is shown below, and each block is previewed separately at the version this review would use.'}
                  </Alert>
                  {blockGuard?.templateContent != null && (
                    <JsonView
                      value={blockGuard.templateContent}
                      label={
                        blockGuard.templateVersion
                          ? `Template version v${blockGuard.templateVersion} as JSON (the exact reviewed content)`
                          : 'Template as JSON (the exact reviewed content)'
                      }
                      maxHeight={480}
                    />
                  )}
                  {blockGuard && (
                    <BundledBlocks pins={blockGuard.pins} loading={false} error={null} onRetry={blockGuard.onRetry} showHeading />
                  )}
                </div>
              )
            ) : tpl.artifact ? (
              <EmailPreview
                compact
                artifactId={content.template}
                version={templateVersion ?? tpl.artifact.publishedVersion ?? undefined}
                source={nestedSource}
                sourceSuffix={templateVersion ? 'In this bundle' : undefined}
                reportId={`${reportId}:template`}
              />
            ) : tpl.error ? (
              <Alert tone="bad">{tpl.error}</Alert>
            ) : (
              <Skeleton className="h-40" />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3.5 py-3">
      <p className="text-[12px] text-muted">{label}</p>
      <div className="mt-0.5 text-[18px] leading-6 font-semibold tabular-nums">{children}</div>
    </div>
  );
}
