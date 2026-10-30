import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Card, Meta, Skeleton } from '../../ui';
import { formatDateTime, getWorkspaceTimeZone } from '../../ui/time';
import { useArtifactRef } from '../artifactCache';
import { EmailPreview } from './EmailPreview';
import { RefName } from './FormPreview';

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
}) {
  const { can } = useSession();
  const reach = useApi(
    () => api.call('broadcasts.preview', { artifactId, version, templateVersion }),
    [artifactId, version, templateVersion],
    {
      skip: !can('artifacts:read'),
    },
  );
  const tpl = useArtifactRef(content.template);
  const isEmail = content.template?.startsWith('eml_');
  return (
    <div className="space-y-4">
      {content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Would receive it now">
          {reach.loading ? (
            <Skeleton className="h-5 w-16" />
          ) : reach.error ? (
            <span className="text-[13px] text-bad">{reach.error}</span>
          ) : (
            reach.data?.wouldSend.toLocaleString()
          )}
        </Stat>
        <Stat label="In the segment">
          {reach.loading ? <Skeleton className="h-5 w-16" /> : (reach.data?.audience.toLocaleString() ?? '—')}
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
            {tpl.artifact ? (
              <EmailPreview compact artifactId={content.template} version={templateVersion ?? tpl.artifact.publishedVersion ?? undefined} />
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
