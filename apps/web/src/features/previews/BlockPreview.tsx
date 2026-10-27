import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, LoadingBlock, Segmented } from '../../ui';
import { emailDoc } from './EmailPreview';

/** A block as it looks with its default parameters (blocks.preview). */
export function BlockPreview({ artifactId, version, compact }: { artifactId: string; version?: number; compact?: boolean }) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));
  const { data, error, loading, reload } = useApi(() => api.call('blocks.preview', { artifactId, version }), [artifactId, version]);
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
          style={{ width: width === 'mobile' ? 375 : '100%', maxWidth: width === 'mobile' ? 375 : 720, height: compact ? 420 : 640, border: 0 }}
        />
      </div>
      <p className="text-[12px] text-muted">Rendered from version {data.version} with the block’s default parameters.</p>
    </div>
  );
}
