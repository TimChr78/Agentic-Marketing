import { lazy, Suspense } from 'react';
import { JsonView, LoadingBlock } from '../../ui';
import { referencedIds, useArtifactNames } from '../artifactCache';
import type { JourneyContent } from '../journey/model';
import type { DraftEmailContent } from '../templates/localRender';
import { BlockPreview } from './BlockPreview';
import { BroadcastPreview } from './BroadcastPreview';
import { EmailPreview } from './EmailPreview';
import { type FormContent, FormPreview } from './FormPreview';
import { PreviewLabel } from './PreviewLabel';
import type { PreviewSource } from './previewSource';
import { ReportPreviewStatus } from './previewStatus';
import { SegmentPreview } from './SegmentPreview';

// React Flow is large and only needed when an approval actually previews a journey (#60).
const JourneyGraph = lazy(() => import('../journey/JourneyGraph').then((m) => ({ default: m.JourneyGraph })));

/** Types the approval drawer can show as the real thing rather than JSON. */
export const PREVIEWABLE = new Set(['email_template', 'email_block', 'form', 'journey', 'segment', 'broadcast']);

/**
 * The object itself, by type (#41). Falls back to its content as JSON. `bundle` maps the other
 * artifacts reviewed together (#107) to their versions under review, e.g. a broadcast's template.
 * `source` says which provenance the caller is showing; it never changes which version is fetched.
 */
export function ArtifactPreview({
  type,
  artifactId,
  version,
  content,
  compact,
  bundle,
  source,
  sourceSuffix,
  reportId = 'artifact',
}: {
  type: string;
  artifactId: string;
  version?: number;
  content: unknown;
  compact?: boolean;
  bundle?: Record<string, number>;
  source?: PreviewSource;
  sourceSuffix?: string;
  /** Readiness slot reported to the Review panel. */
  reportId?: string;
}) {
  // Old callers pass the exact version they render. That is a Saved vN pin, not an inference about
  // the publication pointer; C supplies Published only when it selected the published version.
  const resolved: PreviewSource | undefined = source ?? (version != null ? { kind: 'saved', version } : undefined);
  const draftContent = resolved?.kind === 'unsaved' ? (content as DraftEmailContent) : undefined;
  switch (type) {
    case 'email_template':
      return (
        <EmailPreview
          artifactId={artifactId}
          version={version}
          compact={compact}
          source={resolved}
          draftContent={draftContent}
          sourceSuffix={sourceSuffix}
          reportId={reportId}
        />
      );
    case 'email_block':
      return (
        <BlockPreview
          artifactId={artifactId}
          version={version}
          compact={compact}
          source={resolved}
          sourceSuffix={sourceSuffix}
          reportId={reportId}
        />
      );
    case 'form':
      return (
        <>
          <ReportPreviewStatus id={reportId} />
          <FormPreview content={content as FormContent} source={resolved} sourceSuffix={sourceSuffix} />
        </>
      );
    case 'segment':
      return (
        <SegmentPreview
          artifactId={artifactId}
          version={version}
          content={content as { condition?: unknown }}
          source={resolved}
          sourceSuffix={sourceSuffix}
          reportId={reportId}
        />
      );
    case 'broadcast':
      return (
        <BroadcastPreview
          artifactId={artifactId}
          version={version}
          content={content as { template?: string; segment?: string }}
          templateVersion={bundle?.[(content as { template?: string }).template ?? '']}
          source={resolved}
          sourceSuffix={sourceSuffix}
          reportId={reportId}
        />
      );
    case 'journey':
      return (
        <>
          <ReportPreviewStatus id={reportId} />
          <JourneyPreview content={content as JourneyContent} height={compact ? 420 : 560} source={resolved} sourceSuffix={sourceSuffix} />
        </>
      );
    default:
      return (
        <div className="space-y-2">
          <ReportPreviewStatus id={reportId} />
          {resolved && <PreviewLabel source={resolved} suffix={sourceSuffix} />}
          <JsonView value={content} label="Content" maxHeight={compact ? 480 : 720} />
        </div>
      );
  }
}

function JourneyPreview({
  content,
  height,
  source,
  sourceSuffix,
}: {
  content: JourneyContent;
  height: number;
  source?: PreviewSource;
  sourceSuffix?: string;
}) {
  const names = useArtifactNames(referencedIds(content.nodes));
  return (
    <div className="space-y-2">
      {source && <PreviewLabel source={source} suffix={sourceSuffix} />}
      <p className="text-[13px] text-fg-2">
        Purpose <strong className="font-medium">{content.purpose}</strong>
        {content.goal ? <> · Goal: {content.goal}</> : null}
      </p>
      <Suspense
        fallback={
          <div style={{ height }} className="overflow-hidden rounded-md border border-line bg-surface-2">
            <LoadingBlock lines={6} label="Loading the journey graph" />
          </div>
        }
      >
        <JourneyGraph nodes={content.nodes ?? []} names={names} height={height} />
      </Suspense>
    </div>
  );
}
