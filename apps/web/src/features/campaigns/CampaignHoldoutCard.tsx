import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, EmptyState, LoadingBlock } from '../../ui';
import { HoldoutCard } from '../insights/HoldoutCard';

// The campaign's own holdout card (#67): one assignment across all sending members, measured
// against the campaign goal. Self-contained so the evaluation tab can place it untouched.
export function CampaignHoldoutCard({ campaignId }: { campaignId: string }) {
  const artifact = useApi(() => api.call('artifacts.get', { artifactId: campaignId }), [campaignId]);
  const content = artifact.data?.version.content as { controlGroup?: { percent: number } } | undefined;
  const published = artifact.data?.version.state === 'published';
  const hasControl = !!content?.controlGroup;
  const result = useApi(() => api.call('campaigns.holdoutResult', { campaignId }), [campaignId], {
    skip: !hasControl || !published,
  });

  if (artifact.error)
    return (
      <Alert tone="bad" title="Couldn't load the campaign" onRetry={artifact.reload}>
        {artifact.error}
      </Alert>
    );
  if (artifact.loading) return <LoadingBlock lines={4} label="Loading the campaign holdout" />;
  if (!hasControl)
    return (
      <EmptyState compact title="No control group">
        Set a control group in the campaign editor and publish it to measure what the campaign adds over reaching nobody.
      </EmptyState>
    );
  if (!published)
    return (
      <EmptyState compact title="Not published yet">
        The holdout result appears once a version with this control group is published and people are assigned.
      </EmptyState>
    );
  return <HoldoutCard title="Campaign holdout result" result={result.data} loading={result.loading} error={result.error ?? undefined} />;
}
