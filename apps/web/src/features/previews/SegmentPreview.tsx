import { Users } from 'lucide-react';
import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Card, Skeleton } from '../../ui';
import { ConditionView } from './ConditionView';

/** A segment's condition in words, or its mode, and its estimated size now (#41, #83). */
export function SegmentPreview({
  artifactId,
  version,
  content,
}: {
  artifactId: string;
  version?: number;
  content: { description?: string; mode?: 'dynamic' | 'static' | 'snapshot'; condition?: unknown; sourceSegment?: string; snapshotVersion?: number };
}) {
  const { can } = useSession();
  const size = useApi(() => api.call('segments.preview', { artifactId, version }), [artifactId, version], { skip: !can('profiles:read') });
  const mode = content.mode ?? 'dynamic';
  return (
    <div className="space-y-4">
      {content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}
      <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3.5 py-3">
        <Users size={18} className="text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-muted">Estimated size now</p>
          {!can('profiles:read') ? (
            <p className="text-[13px] text-muted">Your role can't read profiles, so the size isn't shown.</p>
          ) : size.loading ? (
            <Skeleton className="mt-1 h-5 w-24" />
          ) : size.error ? (
            <p className="text-[13px] text-bad">{size.error}</p>
          ) : (
            <p className="text-[18px] leading-6 font-semibold tabular-nums">
              {size.data?.count.toLocaleString()} <span className="text-[13px] font-normal text-muted">people</span>
            </p>
          )}
        </div>
      </div>
      <Card title="Who is in it">
        <div className="p-4">
          {mode === 'dynamic' ? (
            content.condition ? (
              <ConditionView condition={content.condition} />
            ) : (
              <Alert tone="warn">No condition yet.</Alert>
            )
          ) : (
            <p className="text-[13px] text-fg-2">
              {mode === 'snapshot'
                ? `A frozen snapshot of ${content.sourceSegment ?? 'another segment'}${content.snapshotVersion ? ` at v${content.snapshotVersion}` : ''}. Its members stay fixed until it is refreshed.`
                : 'A static list: an explicit set of people, changed by hand, CSV or API. A refresh never changes it.'}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
