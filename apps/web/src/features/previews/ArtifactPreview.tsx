import { lazy, Suspense } from 'react';
import { JsonView, LoadingBlock } from '../../ui';
import { referencedIds, useArtifactNames } from '../artifactCache';
import type { JourneyContent } from '../journey/model';
import { BroadcastPreview } from './BroadcastPreview';
import { EmailPreview } from './EmailPreview';
import { type FormContent, FormPreview } from './FormPreview';
import { SegmentPreview } from './SegmentPreview';

// React Flow is large and only needed when an approval actually previews a journey (#60).
const JourneyGraph = lazy(() => import('../journey/JourneyGraph').then((m) => ({ default: m.JourneyGraph })));

/** Types the approval drawer can show as the real thing rather than JSON. */
export const PREVIEWABLE = new Set(['email_template', 'form', 'journey', 'segment', 'broadcast']);

/**
 * The object itself, by type (#41). Falls back to its content as JSON. `bundle` maps the other
 * artifacts reviewed together (#107) to their versions under review, e.g. a broadcast's template.
 */
export function ArtifactPreview({
  type,
  artifactId,
  version,
  content,
  compact,
  bundle,
}: {
  type: string;
  artifactId: string;
  version?: number;
  content: unknown;
  compact?: boolean;
  bundle?: Record<string, number>;
}) {
  switch (type) {
    case 'email_template':
      return <EmailPreview artifactId={artifactId} version={version} compact={compact} />;
    case 'form':
      return <FormPreview content={content as FormContent} />;
    case 'segment':
      return <SegmentPreview artifactId={artifactId} version={version} content={content as { condition?: unknown }} />;
    case 'broadcast':
      return (
        <BroadcastPreview
          artifactId={artifactId}
          version={version}
          content={content as { template?: string; segment?: string }}
          templateVersion={bundle?.[(content as { template?: string }).template ?? '']}
        />
      );
    case 'journey':
      return <JourneyPreview content={content as JourneyContent} height={compact ? 420 : 560} />;
    default:
      return <JsonView value={content} label="Content" maxHeight={compact ? 480 : 720} />;
  }
}

function JourneyPreview({ content, height }: { content: JourneyContent; height: number }) {
  const names = useArtifactNames(referencedIds(content.nodes));
  return (
    <div className="space-y-2">
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
