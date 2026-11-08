import { ExternalLink, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { useAllArtifacts } from '../../features/artifacts/artifactList';
import { JourneyReport } from '../../features/journey/report/JourneyReport';
import { Alert, EmptyState, Field, ListSkeleton, PageHeader, Select } from '../../ui';
import { pageWidth } from '../../ui/layout';

export { JourneyReport };

/**
 * Journey reports. The standalone Insights page keeps a journey picker; the journey detail's
 * Report tab mounts the same `JourneyReport` for its route id (#507), without listing journeys.
 */
export default function JourneyStatsPage({
  journeyId,
  embedded = false,
  active = true,
}: {
  journeyId?: string;
  embedded?: boolean;
  active?: boolean;
} = {}) {
  if (embedded)
    return journeyId ? (
      <JourneyReport journeyId={journeyId} active={active} />
    ) : (
      <Alert tone="info" title="Choose a journey">
        Open a journey from the Journeys list to see its report.
      </Alert>
    );
  return <StandaloneJourneyStats journeyId={journeyId} />;
}

function StandaloneJourneyStats({ journeyId }: { journeyId?: string }) {
  useCrumbs([{ label: 'Journey stats' }]);
  const { can } = useSession();
  const [selected, setSelected] = useState(journeyId ?? '');

  const journeys = useAllArtifacts('journey');
  useEffect(() => {
    if (journeyId && journeyId !== selected) setSelected(journeyId);
    else if (!journeyId && !selected && journeys.data?.artifacts.length) setSelected(journeys.data.artifacts[0].id);
  }, [journeyId, journeys.data, selected]);

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Journey stats"
        description="How many people are at each step of a journey right now, and how many reached it."
        actions={
          selected && (
            <ButtonLink to={`/marketing/journeys/${selected}`} icon={<ExternalLink size={15} />}>
              Open in builder
            </ButtonLink>
          )
        }
      />

      {journeys.loading ? (
        <ListSkeleton label="Loading journeys" columns={3} />
      ) : journeys.error ? (
        <Alert tone="bad" title="Couldn't load journeys" onRetry={journeys.reload}>
          {journeys.error}
        </Alert>
      ) : (journeys.data?.artifacts.length ?? 0) === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={<Workflow size={16} />}
            title="No journeys yet"
            action={
              can('artifacts:write') && (
                <ButtonLink to="/marketing/journeys" variant="primary">
                  Create a journey
                </ButtonLink>
              )
            }
          >
            Build a journey from a trigger to a goal, publish it, and its participants appear here.
          </EmptyState>
        </div>
      ) : (
        <div className="space-y-5">
          {!journeyId && (
            <Field label="Journey" className="max-w-[380px]">
              <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {(journeys.data?.artifacts ?? []).map((journey) => (
                  <option key={journey.id} value={journey.id}>
                    {journey.name}
                    {journey.publishedVersion ? ` · live v${journey.publishedVersion}` : ` · ${journey.latestState.replace(/_/g, ' ')}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {selected && <JourneyReport journeyId={selected} />}
        </div>
      )}
    </div>
  );
}
