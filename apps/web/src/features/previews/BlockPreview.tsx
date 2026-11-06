import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, LoadingBlock, Segmented } from '../../ui';
import { useArtifactRef } from '../artifactCache';
import { emailDoc } from './EmailPreview';
import { PreviewLabel } from './PreviewLabel';
import { type PreviewSource, resolvePreviewSource } from './previewSource';

/** A block as it looks with its default parameters (blocks.preview). */
export function BlockPreview({
  artifactId,
  version,
  compact,
  source,
  sourceSuffix,
}: {
  artifactId: string;
  version?: number;
  compact?: boolean;
  source?: PreviewSource;
  sourceSuffix?: string;
}) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));
  const unsaved = source?.kind === 'unsaved';
  const pinned = source && source.kind !== 'unsaved' ? source.version : version;
  // A dirty block has no local renderer in the preview host. Never fetch the saved version and
  // show it under an Unsaved label; say what will make it render instead.
  const pointer = useArtifactRef(!source && version == null ? artifactId : null);
  const { data, error, loading, reload } = useApi(() => api.call('blocks.preview', { artifactId, version: pinned }), [artifactId, pinned], {
    skip: unsaved,
  });
  const resolved =
    source ??
    resolvePreviewSource({
      requestedVersion: version,
      resolvedVersion: data?.version,
      publishedVersion: pointer.artifact?.publishedVersion,
    });
  if (unsaved)
    return (
      <div className="space-y-3">
        {source && <PreviewLabel source={source} suffix={sourceSuffix} />}
        <Alert tone="warn" title="Save draft to render this block">
          A block preview renders a saved version with its default parameters. Nothing saved is shown under an unsaved label.
        </Alert>
      </div>
    );
  if (loading) return <LoadingBlock lines={6} label="Rendering the block" />;
  if (error)
    return (
      <Alert tone="bad" title="Couldn't render this block" onRetry={reload}>
        {error}
      </Alert>
    );
  if (!data) return null;
  return (
    <div className="space-y-3">
      {resolved && <PreviewLabel source={resolved} suffix={sourceSuffix} />}
      {data.warnings.length > 0 && (
        <Alert tone="warn" title="Rendering warnings">
          <ul className="list-disc pl-4">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex justify-end">
        <Segmented
          label="Preview width"
          value={width}
          onChange={setWidth}
          items={[
            { key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },
            { key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },
          ]}
        />
      </div>
      <div className="flex justify-center rounded-md border border-line bg-surface-3 p-3">
        <iframe
          title={`Block preview, ${width}`}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={emailDoc(data.html)}
          className="rounded-sm bg-white shadow-1"
          style={{
            width: width === 'mobile' ? 375 : '100%',
            maxWidth: width === 'mobile' ? 375 : 720,
            height: compact ? 420 : 640,
            border: 0,
          }}
        />
      </div>
      <p className="text-[12px] text-muted">Rendered from version {data.version} with the block’s default parameters.</p>
    </div>
  );
}
