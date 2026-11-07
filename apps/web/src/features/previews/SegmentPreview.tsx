import { Users } from 'lucide-react';
import { api } from '../../app/api';
import { useSession } from '../../app/session';
import { Alert, Card, Skeleton } from '../../ui';
import { ConditionView } from './ConditionView';
import { PreviewLabel } from './PreviewLabel';
import { useSharedRead } from './previewRead';
import { type PreviewSource, resolvePreviewSource } from './previewSource';
import { type PreviewStatus, useReportPreviewStatus } from './previewStatus';

/** A segment's condition in words, or its mode, and its estimated size now (#41, #83). */
export function SegmentPreview({
  artifactId,
  version,
  content,
  source,
  sourceSuffix,
  reportId = 'artifact',
}: {
  artifactId: string;
  version?: number;
  content: {
    description?: string;
    mode?: 'dynamic' | 'static' | 'snapshot';
    condition?: unknown;
    sourceSegment?: string;
    snapshotVersion?: number;
  };
  source?: PreviewSource;
  sourceSuffix?: string;
  /** Which readiness slot this renderer reports to the Review panel. */
  reportId?: string;
}) {
  const { can } = useSession();
  const unsaved = source?.kind === 'unsaved';
  // An explicit version always wins; `source` is provenance, not a second way to choose a read.
  const pinned = version ?? (source && source.kind !== 'unsaved' ? source.version : undefined);
  const skip = !can('profiles:read') || unsaved;
  const size = useSharedRead(
    'segments.preview',
    { artifactId, version: pinned },
    () => api.call('segments.preview', { artifactId, version: pinned }),
    { skip },
  );
  const mode = content.mode ?? 'dynamic';
  const resolved = source ?? (version != null ? { kind: 'saved' as const, version } : resolvePreviewSource({ requestedVersion: version }));
  const status: PreviewStatus = skip ? 'ready' : size.loading ? 'loading' : size.error ? 'error' : 'ready';
  useReportPreviewStatus(reportId, status);
  return (
    <div className="space-y-4">
      {resolved && <PreviewLabel source={resolved} suffix={sourceSuffix} />}
      {content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}
      <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3.5 py-3">
        <Users size={18} className="text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-muted">Estimated size now</p>
          {unsaved ? (
            <p className="text-[13px] text-muted">Save draft to estimate membership</p>
          ) : !can('profiles:read') ? (
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
