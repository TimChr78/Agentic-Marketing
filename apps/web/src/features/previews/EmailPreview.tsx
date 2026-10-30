import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, CodeView, LoadingBlock, Meta, Segmented, Tabs } from '../../ui';
import { ChecksPanel } from './ChecksPanel';

/** Wraps rendered e-mail HTML so links open outside the sandboxed preview. */
export function emailDoc(html: string) {
  return html.includes('<head>') ? html.replace('<head>', '<head><base target="_blank">') : `<base target="_blank">${html}`;
}

/**
 * An e-mail as the recipient sees it (#41): rendered by the server with the template's sample
 * data, at desktop and mobile width, with subject, preheader and the plain-text part.
 */
export function EmailPreview({ artifactId, version, compact }: { artifactId: string; version?: number; compact?: boolean }) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const { data, error, loading, reload } = useApi(() => api.call('templates.preview', { artifactId, version }), [artifactId, version]);
  if (loading) return <LoadingBlock lines={6} label="Rendering the e-mail" />;
  if (error)
    return (
      <Alert tone="bad" title="Couldn't render this e-mail" onRetry={reload}>
        {error}
      </Alert>
    );
  if (!data) return null;
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <Meta
          items={[
            ['Subject', <span className="font-medium">{data.subject}</span>],
            [
              'Preheader',
              data.preheader ? data.preheader : <span className="text-muted">None. Inboxes show the first line of the body instead.</span>,
            ],
          ]}
        />
      </div>
      {data.warnings.length > 0 && (
        <Alert tone="warn" title="Rendering warnings">
          <ul className="list-disc pl-4">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <ChecksPanel artifactId={artifactId} version={version} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          label="Version"
          items={[
            { key: 'html', label: 'HTML' },
            { key: 'text', label: 'Text version' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'html' && (
          <Segmented
            label="Preview width"
            value={width}
            onChange={setWidth}
            items={[
              { key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },
              { key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },
            ]}
          />
        )}
      </div>
      {tab === 'html' ? (
        <div className="flex justify-center rounded-md border border-line bg-surface-3 p-3">
          <iframe
            title={`E-mail preview, ${width}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={emailDoc(data.html)}
            className="rounded-sm bg-white shadow-1"
            style={{
              width: width === 'mobile' ? 375 : '100%',
              maxWidth: width === 'mobile' ? 375 : 720,
              height: compact ? 520 : 720,
              border: 0,
            }}
          />
        </div>
      ) : (
        <CodeView value={data.text || '(empty)'} label="Plain-text part" maxHeight={compact ? 420 : 640} />
      )}
      <p className="text-[12px] text-muted">Rendered from version {data.version} with the template's sample data.</p>
    </div>
  );
}
