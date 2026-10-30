import { Monitor, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { Alert, Segmented, Skeleton, Tabs } from '../../ui';
import { PAGE_KINDS, type PageKind } from './defaults';

/**
 * A hosted page as subscribers see it (#37), rendered by the server's own renderer: the published
 * brand, a draft `brand` being edited, or a form's override (`formId`). Sandboxed, no scripts.
 */
export function HostedPreview({
  brand,
  formId,
  initialPage = 'confirm',
  height = 560,
}: {
  brand?: unknown;
  formId?: string;
  initialPage?: PageKind;
  height?: number;
}) {
  const [page, setPage] = useState<PageKind>(initialPage);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(brand ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: brand is keyed by its JSON form so an equal-object prop does not refetch on every render
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .call('hostedPages.preview', { page, ...(brand ? { brand: brand as never } : {}), ...(formId ? { formId } : {}) })
        .then((r) => {
          if (!live) return;
          setHtml(r.html);
          setError(null);
        })
        .catch((e) => live && setError(errText(e)));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [page, key, formId]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Tabs label="Page" items={PAGE_KINDS.map((p) => ({ key: p.key, label: p.label }))} value={page} onChange={setPage} />
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
      {error && (
        <Alert tone="bad" title="Can't preview this yet">
          {error}
        </Alert>
      )}
      <div className="flex justify-center rounded-md border border-line bg-surface-3 p-3">
        {html ? (
          <iframe
            title={`Hosted ${page} page preview`}
            sandbox=""
            srcDoc={html}
            className="rounded-sm bg-white shadow-1"
            style={{ width: width === 'mobile' ? 375 : '100%', height, border: 0 }}
          />
        ) : (
          <Skeleton className="w-full" />
        )}
      </div>
    </div>
  );
}
