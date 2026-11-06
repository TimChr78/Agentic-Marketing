import type { ReactNode } from 'react';
import { api } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { TextLink } from '../../app/links';
import { useApi } from '../../app/useApi';
import { Identifier } from '../../ui/Identifier';
import { formatDateTime } from '../../ui/time';
import type { BroadcastContent, BroadcastDetailArtifact, BroadcastStatusData } from './detailView';
import type { ArtifactName } from './names';

// The broadcast context panel (#448): published/latest versions, the actual version author, the
// pinned segment and template, the schedule, preparation and current delivery counts, campaign
// membership and artifact references. Missing references are shown as unavailable with their id
// and are never fetched; there is no current-user owner fallback.

const count = (n: number) => n.toLocaleString('en-US');

function ReferenceRow({ id, names }: { id: string; names: Map<string, ArtifactName> }) {
  const known = names.get(id);
  if (known) {
    return <TextLink to={artifactPath(known.type, id)}>{known.name}</TextLink>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-muted">Unavailable reference</span>
      <Identifier value={id} label="Reference ID" />
    </span>
  );
}

function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] leading-[18px] text-muted">{term}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-[13px] leading-5 text-fg-2">{children}</dd>
    </div>
  );
}

export function BroadcastContext({
  artifact,
  status,
  segmentName,
  templateName,
  names,
}: {
  artifact: BroadcastDetailArtifact;
  status: { data: BroadcastStatusData | undefined; loading: boolean; error: string | null };
  segmentName?: string | null;
  templateName?: string | null;
  names: Map<string, ArtifactName>;
}) {
  const campaigns = useApi(() => api.call('campaigns.of', { artifactId: artifact.id }), [artifact.id]);
  const content = (artifact.version.content ?? {}) as BroadcastContent;
  const run = status.data?.run;
  const delivery = status.data?.delivery;
  const author = artifact.version.by?.displayName ?? (artifact.version.author.type === 'agent' ? 'an agent' : 'a person');

  const schedule = run?.sendAt
    ? formatDateTime(run.sendAt, { zone: true })
    : content.sendAt
      ? `${formatDateTime(content.sendAt, { zone: true })} (saved)`
      : 'On publication';

  const preparation =
    !run || run.status === 'not_scheduled'
      ? 'Eligibility checked on review'
      : run.status === 'scheduled'
        ? 'Not prepared yet'
        : `${count(run.recipients)} reached · ${count(run.queued)} queued · ${count(run.skipped)} skipped · ${count(run.windowSkipped)} window-skipped`;

  let currentDelivery: ReactNode;
  if (status.error) currentDelivery = 'Unavailable · retry status';
  else if (status.loading || !status.data) currentDelivery = 'Checking…';
  else if (!run || run.status === 'not_scheduled' || run.status === 'scheduled') currentDelivery = 'Not started';
  else if (!delivery) currentDelivery = 'Delivery unavailable';
  else {
    const accepted = (delivery.sent ?? 0) + (delivery.delivered ?? 0) + (delivery.bounced ?? 0) + (delivery.complained ?? 0);
    const pending = (delivery.queued ?? 0) + (delivery.sending ?? 0);
    const failed = delivery.failed ?? 0;
    const suppressed = delivery.suppressed ?? 0;
    if (!accepted && !pending && !failed && !suppressed) currentDelivery = 'No messages';
    else
      currentDelivery = (
        <>
          {accepted > 0 && <div>{count(accepted)} provider-accepted</div>}
          {pending > 0 && <div>{count(pending)} awaiting provider</div>}
          {failed > 0 && <div>{count(failed)} failed</div>}
          {suppressed > 0 && <div>{count(suppressed)} suppressed</div>}
        </>
      );
  }

  return (
    <div>
      <h2 className="mb-3 text-[16px] leading-6 font-semibold">Context</h2>
      <dl className="space-y-3">
        <Definition term="Versions">
          {artifact.publishedVersion !== null
            ? `Published v${artifact.publishedVersion} · latest v${artifact.latestVersion}`
            : `Not published · latest v${artifact.latestVersion}`}
        </Definition>
        <Definition term="Changed by">{author}</Definition>
        <Definition term="Segment">
          {content.segment ? (
            segmentName ? (
              <TextLink to={artifactPath('segment', content.segment)}>{segmentName}</TextLink>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Unavailable reference</span>
                <Identifier value={content.segment} label="Segment ID" />
              </span>
            )
          ) : (
            'Not set'
          )}
        </Definition>
        <Definition term="Template">
          {content.template ? (
            templateName ? (
              <TextLink to={artifactPath('email_template', content.template)}>{templateName}</TextLink>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Unavailable reference</span>
                <Identifier value={content.template} label="Template ID" />
              </span>
            )
          ) : (
            'Not set'
          )}
        </Definition>
        <Definition term="Schedule">{schedule}</Definition>
        <Definition term="Preparation">{preparation}</Definition>
        <Definition term="Current delivery">{currentDelivery}</Definition>
        <Definition term="Campaign">
          {campaigns.loading ? (
            'Checking…'
          ) : campaigns.error ? (
            'Unavailable'
          ) : campaigns.data?.campaigns.length ? (
            <span className="space-y-1">
              {campaigns.data.campaigns.map((campaign) => (
                <div key={campaign.id}>
                  <TextLink to={`/build/campaigns/${campaign.id}`}>{campaign.name}</TextLink>
                </div>
              ))}
            </span>
          ) : (
            'None'
          )}
        </Definition>
        <Definition term="Dependencies">
          {artifact.references.length ? (
            <span className="space-y-1">
              {artifact.references.map((id) => (
                <div key={id}>
                  <ReferenceRow id={id} names={names} />
                </div>
              ))}
            </span>
          ) : (
            'None'
          )}
        </Definition>
      </dl>
    </div>
  );
}
