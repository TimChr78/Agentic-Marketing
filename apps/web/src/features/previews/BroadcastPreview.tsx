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

/** A broadcast (#41): template, segment, who would get it now, and when it sends. */
export function BroadcastPreview({ artifactId, version, content }: { artifactId: string; version?: number; content: { template?: string; segment?: string; sendAt?: string; description?: string } }) {
  const { can } = useSession();
  const reach = useApi(() => api.call('broadcasts.preview', { artifactId, version }), [artifactId, version], { skip: !can('artifacts:read') });
  const tpl = useArtifactRef(content.template);
  const isEmail = content.template?.startsWith('eml_');
  return (
    <div className="space-y-4">
      {content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Would receive it now">
          {reach.loading ? <Skeleton className="h-5 w-16" /> : reach.error ? <span className="text-[13px] text-bad">{reach.error}</span> : reach.data?.wouldSend.toLocaleString()}
        </Stat>
        <Stat label="In the segment">{reach.loading ? <Skeleton className="h-5 w-16" /> : (reach.data?.audience.toLocaleString() ?? '—')}</Stat>
        <Stat label="Sends">
          <span className="text-[14px]">{content.sendAt ? formatDateTime(content.sendAt, { zone: true }) : 'As soon as it is approved'}</span>
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
          {reach.data.checked < reach.data.audience && <p className="mt-1">Estimated from {reach.data.checked.toLocaleString()} people checked.</p>}
        </Alert>
      )}
      <Card>
        <div className="p-4">
          <Meta
            items={[
              ['Template', <RefName id={content.template} />],
              ['Segment', <RefName id={content.segment} />],
              ['Time zone', `Shown in ${getWorkspaceTimeZone()}`],
            ]}
          />
        </div>
      </Card>
      {isEmail && content.template && (
        <Card title="The e-mail" description={tpl.artifact?.publishedVersion ? `Live version v${tpl.artifact.publishedVersion} of the template` : 'The template is not published yet; showing its latest draft'}>
          <div className="p-4">
            {tpl.artifact ? <EmailPreview compact artifactId={content.template} version={tpl.artifact.publishedVersion ?? undefined} /> : tpl.error ? <Alert tone="bad">{tpl.error}</Alert> : <Skeleton className="h-40" />}
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
