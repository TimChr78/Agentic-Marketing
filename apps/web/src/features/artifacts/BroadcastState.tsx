import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { stateOfBroadcast } from '../../lib/state';
import { Skeleton } from '../../ui';
import { OperationalPill } from '../../ui/state';

/**
 * The operational pill for one broadcast. A published broadcast's run status is the only place the
 * API currently says scheduled, sending, sent, stopped or blocked; `artifacts.list` carries the
 * publication version only.
 *
 * TODO(#437/B1): this is one `broadcasts.status` call per visible list row. B1 (`broadcasts.list`)
 * replaces the fan-out with a bounded list read that returns the same run and stage fields; the
 * state model already accepts them, so only this data source changes.
 */
export function BroadcastStatePill({
  artifactId,
  latestState,
  publishedVersion,
}: {
  artifactId: string;
  latestState: string;
  publishedVersion: number | null;
}) {
  const status = useApi(() => api.call('broadcasts.status', { artifactId }), [artifactId], {
    skip: publishedVersion === null,
  });
  // A published broadcast's operational state is unknown until its run is read. Never fill that
  // gap with "Published": that would imply a send outcome the UI has not seen.
  if (publishedVersion !== null && status.loading) return <Skeleton className="h-5 w-24 rounded-full" />;
  if (publishedVersion !== null && status.error)
    return (
      <OperationalPill state={{ key: 'unknown', label: 'Send state unavailable', tone: 'neutral', icon: 'dot', detail: status.error }} />
    );
  const state = stateOfBroadcast({
    type: 'broadcast',
    latestState,
    publishedVersion,
    run: status.data?.run ?? null,
    stage: status.data?.stage ?? null,
    messages: status.data?.messages ?? null,
  });
  return (
    <span title={state.detail}>
      <OperationalPill state={state} />
    </span>
  );
}
