import { useMemo, useState } from 'react';
import { api } from '../../../app/api';
import { useWorkspace } from '../../../app/session';
import { useApi } from '../../../app/useApi';
import { Alert, LoadingBlock } from '../../../ui';
import { HoldoutPanel } from './HoldoutPanel';
import {
  type CampaignArtifactView,
  type CampaignDefinitionContent,
  isNotFound,
  ownPeriod,
  periodLabelOf,
  safeReturnedPeriodLabel,
  zoneOf,
} from './model';

// The campaign's own holdout (#511). It reuses the host's published definition when the host passes
// it; a newer draft adds exactly one pinned artifacts.get for the published version. The read is
// skipped entirely without a published control group or a goal event, and the shared period keeps
// it in step with the evaluation summary.

type PublishedDefinition = { published: boolean; content: unknown };

export interface CampaignHoldoutViewProps {
  campaignId: string;
  from?: string;
  to?: string;
  active?: boolean;
  refreshKey?: number;
  artifact?: CampaignArtifactView;
}

export function CampaignHoldoutView({ campaignId, from, to, active = true, refreshKey = 0, artifact }: CampaignHoldoutViewProps) {
  const { can } = useWorkspace();
  const allowed = can('artifacts:read');
  const hostBounds = from && to ? { from, to } : null;
  const [anchor] = useState(() => new Date());
  const own = useMemo(() => ownPeriod(7, anchor), [anchor]);
  const bounds = hostBounds ?? { from: own.from, to: own.to };

  const definition = useApi<PublishedDefinition>(
    async () => {
      if (artifact) {
        if (artifact.publishedVersion === null) return { published: false, content: null };
        if (artifact.version.number === artifact.publishedVersion) {
          return { published: true, content: artifact.version.content };
        }
        const pinned = await api.call('artifacts.get', { artifactId: campaignId, version: artifact.publishedVersion });
        return { published: true, content: pinned.version.content };
      }
      const latest = await api.call('artifacts.get', { artifactId: campaignId });
      if (latest.publishedVersion === null) return { published: false, content: null };
      if (latest.version.number === latest.publishedVersion) {
        return { published: true, content: latest.version.content };
      }
      const pinned = await api.call('artifacts.get', { artifactId: campaignId, version: latest.publishedVersion });
      return { published: true, content: pinned.version.content };
    },
    [campaignId, artifact, refreshKey],
    { skip: !allowed || !active },
  );

  const content = (definition.data?.content ?? null) as CampaignDefinitionContent | null;
  const control = content?.controlGroup;
  const goal = content?.goal;
  const hasControl = !!control;
  const hasGoal = !!goal?.event;

  const result = useApi(
    () => api.call('campaigns.holdoutResult', { campaignId, from: bounds.from, to: bounds.to }),
    [campaignId, bounds.from, bounds.to, hasControl, hasGoal, refreshKey],
    { skip: !allowed || !active || !hasControl || !hasGoal },
  );

  if (!active) return null;
  if (!allowed) {
    return (
      <Alert tone="info" title="Holdout restricted">
        Your role needs artifacts:read. No holdout result has been loaded.
      </Alert>
    );
  }

  if (definition.error) {
    if (isNotFound(definition.error)) {
      return (
        <Alert tone="info" title="Campaign not found">
          This item is not available at this address. It may have been deleted or belongs to another workspace.
        </Alert>
      );
    }
    return (
      <Alert tone="bad" title="Couldn't load the campaign definition" onRetry={definition.reload}>
        {definition.error}
      </Alert>
    );
  }
  if (definition.refreshing || !definition.data) {
    return (
      <section aria-busy="true" aria-label="Loading the campaign holdout">
        <LoadingBlock lines={5} label="Loading the campaign holdout" />
      </section>
    );
  }

  if (!definition.data.published) {
    return (
      <Alert tone="info" title="No campaign control group">
        The campaign has no published version, so there is no published control group to measure. Publish a version with a control group
        first.
      </Alert>
    );
  }

  if (!hasControl || !hasGoal) {
    return (
      <div className="space-y-3">
        {!hasGoal && (
          <Alert tone="info" title="Set a campaign goal event">
            A conversion or revenue goal event is required to measure uplift. Set the goal in the campaign editor and publish it.
          </Alert>
        )}
        {!hasControl && (
          <Alert tone="info" title="No campaign control group">
            Set a control group in the campaign editor and publish it to measure what the campaign adds over reaching nobody. Journey
            controls, if present, stay separate.
          </Alert>
        )}
      </div>
    );
  }

  if (result.error) {
    return (
      <Alert tone="bad" title="Couldn't load the campaign holdout" onRetry={result.reload}>
        {result.error}
      </Alert>
    );
  }
  if (result.refreshing || !result.data) {
    return (
      <section aria-busy="true" aria-label="Loading the campaign holdout">
        <LoadingBlock lines={5} label="Loading the campaign holdout" />
      </section>
    );
  }

  const zone = zoneOf(undefined);
  const assignmentPeriod = safeReturnedPeriodLabel(result.data.from, result.data.to, zone) ?? periodLabelOf(bounds, zone);

  return (
    <HoldoutPanel
      title="Campaign-wide holdout"
      kind="campaign"
      controlGroup={result.data.controlGroup}
      control={result.data.control}
      treatment={result.data.treatment}
      absoluteLift={result.data.absoluteLift}
      relativeLift={result.data.relativeLift}
      ci95={result.data.ci95}
      minSampleSizeMet={result.data.minSampleSizeMet}
      verdict={result.data.verdict}
      note={result.data.note}
      goalEvent={result.data.goal.event ?? goal?.event ?? null}
      attributionDays={result.data.goal.attributionDays ?? goal?.attributionDays ?? null}
      assignmentPeriod={assignmentPeriod}
    />
  );
}
