import { artifactPath } from '../../app/artifactRoutes';
import { Link } from '../../app/router';
import { stateOfAgent, stateOfBroadcast, stateOfJourney } from '../../lib/state';
import { Alert } from '../../ui/display';
import { OperationalPill } from '../../ui/state';
import { formatDateTime, timeAgo } from '../../ui/time';
import { HomeBlock, HomeBlockEmpty, HomeBlockSkeleton, HomeSection } from './HomeSection';
import type { AgentsResult, BroadcastsResult, HomeData, JourneysResult, Resource } from './useHomeData';

// Running (#447): scheduled and sending broadcasts from B1, live journeys from the first artifact
// page, and active agents from the shared agents read. None of these claims that something is
// executing right now: Active is permission to act and Live is open to enrolment.

function BroadcastRows({ resource, now, onRetry }: { resource: Resource<BroadcastsResult>; now: Date; onRetry: () => void }) {
  if (resource.data === undefined && resource.error !== null)
    return (
      <HomeBlock label="Recently updated scheduled and sending broadcasts">
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load scheduled and sending broadcasts" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  if (resource.data === undefined)
    return (
      <HomeBlock label="Recently updated scheduled and sending broadcasts">
        {<HomeBlockSkeleton label="scheduled and sending broadcasts" />}
      </HomeBlock>
    );
  const broadcasts = resource.data.broadcasts.slice(0, 5);
  return (
    <HomeBlock
      label="Recently updated scheduled and sending broadcasts"
      meta={`As of ${formatDateTime(resource.data.asOf, { zone: true })}`}
      footer={
        broadcasts.length > 0 ? (
          <Link
            to="/marketing/broadcasts?status=active"
            className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0"
          >
            View all broadcasts
          </Link>
        ) : undefined
      }
    >
      {broadcasts.length === 0 ? (
        <HomeBlockEmpty>
          <span>No scheduled or sending broadcasts</span> in this sample.{' '}
          <Link
            to="/marketing/broadcasts?status=active"
            className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0"
          >
            View broadcasts to check their status
          </Link>
          .
        </HomeBlockEmpty>
      ) : (
        broadcasts.map((broadcast) => {
          const state = stateOfBroadcast({
            type: 'broadcast',
            latestState: broadcast.latestState,
            latestVersion: broadcast.latestVersion,
            publishedVersion: broadcast.publishedVersion,
            run: broadcast.run,
            stage: broadcast.stage,
            delivery: broadcast.delivery,
            now,
          });
          const timing =
            broadcast.run.status === 'scheduled' && broadcast.run.sendAt
              ? `Scheduled for ${formatDateTime(broadcast.run.sendAt, { zone: true })}`
              : broadcast.run.status === 'running' && broadcast.run.startedAt
                ? `Started ${formatDateTime(broadcast.run.startedAt, { zone: true })}`
                : `Updated ${formatDateTime(broadcast.updatedAt, { zone: true })}`;
          return (
            <div key={broadcast.artifactId} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
              <div className="min-w-0 flex-1">
                <Link
                  to={artifactPath('broadcast', broadcast.artifactId)}
                  className="text-[13px] leading-5 font-medium break-words text-fg hover:underline"
                >
                  {broadcast.name}
                </Link>
                <p className="mt-1 text-[12px] leading-[18px] text-muted">{timing}</p>
              </div>
              <OperationalPill state={state} />
            </div>
          );
        })
      )}
    </HomeBlock>
  );
}

function JourneyRows({ resource, now, onRetry }: { resource: Resource<JourneysResult>; now: Date; onRetry: () => void }) {
  if (resource.data === undefined && resource.error !== null)
    return (
      <HomeBlock label="Live journeys · recently updated sample">
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load live journeys" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  if (resource.data === undefined)
    return <HomeBlock label="Live journeys · recently updated sample">{<HomeBlockSkeleton label="live journeys" />}</HomeBlock>;
  const live = resource.data.artifacts.filter((artifact) => artifact.publishedVersion !== null).slice(0, 3);
  return (
    <HomeBlock
      label="Live journeys · recently updated sample"
      footer={
        resource.data.nextCursor ? (
          <Link to="/marketing/journeys" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
            View journeys
          </Link>
        ) : undefined
      }
    >
      {live.length === 0 ? (
        <HomeBlockEmpty>
          <span>No live journeys</span> in this sample.{' '}
          <Link to="/marketing/journeys" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
            View journeys to check their status
          </Link>
          .
        </HomeBlockEmpty>
      ) : (
        live.map((journey) => {
          const state = stateOfJourney({
            type: 'journey',
            latestState: journey.latestState,
            latestVersion: journey.latestVersion,
            publishedVersion: journey.publishedVersion,
          });
          return (
            <div key={journey.id} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/marketing/journeys/${encodeURIComponent(journey.id)}?tab=report`}
                  className="text-[13px] leading-5 font-medium break-words text-fg hover:underline"
                >
                  {journey.name}
                </Link>
                <p className="mt-1 text-[12px] leading-[18px] text-muted">
                  Published v{journey.publishedVersion} · live for enrollment · updated {timeAgo(journey.updatedAt, now.getTime())}
                </p>
              </div>
              <OperationalPill state={state} />
            </div>
          );
        })
      )}
    </HomeBlock>
  );
}

function AgentRows({ resource, onRetry }: { resource: Resource<AgentsResult>; onRetry: () => void }) {
  if (resource.data === undefined && resource.error !== null)
    return (
      <HomeBlock label="Active agents · allowed to act">
        <div className="p-4">
          <Alert tone="bad" title="Couldn't load active agents" onRetry={onRetry}>
            {resource.error}
          </Alert>
        </div>
      </HomeBlock>
    );
  if (resource.data === undefined)
    return <HomeBlock label="Active agents · allowed to act">{<HomeBlockSkeleton label="active agents" />}</HomeBlock>;
  const active = resource.data.agents
    .filter((agent) => agent.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const shown = active.slice(0, 3);
  return (
    <HomeBlock
      label="Active agents · allowed to act"
      meta={`${active.length} active`}
      footer={
        <Link to="/work/agents" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
          All agents
        </Link>
      }
    >
      {shown.length === 0 ? (
        <HomeBlockEmpty>
          <span>No active agents</span> in this sample.{' '}
          <Link to="/work/agents" className="inline-flex min-h-10 items-center text-accent hover:underline md:min-h-0">
            View agents to check their status
          </Link>
          .
        </HomeBlockEmpty>
      ) : (
        shown.map((agent) => (
          <div key={agent.id} className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-3 md:px-5">
            <div className="min-w-0 flex-1">
              <Link
                to={`/work/agents/${encodeURIComponent(agent.id)}`}
                className="text-[13px] leading-5 font-medium break-words text-fg hover:underline"
              >
                {agent.name}
              </Link>
              <p className="mt-1 text-[12px] leading-[18px] text-muted">
                {agent.statusReason ?? 'Active is permission to act, not current execution'}
              </p>
            </div>
            <OperationalPill state={stateOfAgent({ status: agent.status, statusReason: agent.statusReason, guard: agent.guard })} />
          </div>
        ))
      )}
    </HomeBlock>
  );
}

export function HomeRunning({ data }: { data: Pick<HomeData, 'resources' | 'clock' | 'retry'> }) {
  const { resources, clock, retry } = data;
  const total = resources.broadcasts.data?.total;
  return (
    <HomeSection
      title="Running"
      meta={total === undefined ? undefined : `${total} scheduled ${total === 1 ? 'or sending broadcast' : 'or sending broadcasts'}`}
      action={
        <Link
          to="/marketing/broadcasts?status=active"
          className="inline-flex min-h-10 items-center text-[13px] leading-5 text-accent hover:underline md:min-h-0"
        >
          View broadcasts
        </Link>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-line">
        <div className="divide-y divide-line">
          <BroadcastRows resource={resources.broadcasts} now={clock.now} onRetry={() => void retry.broadcasts()} />
        </div>
        <div className="divide-y divide-line border-t border-line lg:border-t-0">
          <JourneyRows resource={resources.journeys} now={clock.now} onRetry={() => void retry.journeys()} />
          <AgentRows resource={resources.agents} onRetry={() => void retry.agents()} />
        </div>
      </div>
    </HomeSection>
  );
}
