import { Monitor, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { Alert, Segmented, Skeleton, Tabs } from '../../ui';
import { useArtifactRef } from '../artifactCache';
import { PreviewLabel } from '../previews/PreviewLabel';
import type { PreviewSource } from '../previews/previewSource';
import { PAGE_KINDS, type PageKind } from './defaults';

/**
 * A hosted page as subscribers see it (#37), rendered by the server's own renderer: the published
 * brand, a draft `brand` being edited, or a form's override (`formId`). Sandboxed, no scripts.
 * The label names the source above the frame (Phase 25, #499).
 */
export function HostedPreview({
  brand,
  formId,
  initialPage = 'confirm',
  height = 560,
  source,
}: {
  brand?: unknown;
  formId?: string;
  initialPage?: PageKind;
  height?: number;
  source?: PreviewSource;
}) {
  const [page, setPage] = useState<PageKind>(initialPage);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(brand ?? null);
  const form = useArtifactRef(formId);
  // A local brand object is the unsaved editor copy; no saved version number is known here, so the
  // label makes no "based on" claim. An explicit source (a saved read) wins.
  const brandSource: PreviewSource | undefined = source ?? (brand !== undefined ? { kind: 'unsaved', baseVersion: 0 } : undefined);
  const formSource: PreviewSource | undefined =
    formId && form.artifact?.publishedVersion ? { kind: 'published', version: form.artifact.publishedVersion } : undefined;
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
      {brandSource ? (
        <PreviewLabel source={brandSource} />
      ) : (
        <p className="text-[12px] leading-[18px] text-fg-2">Default hosted-page theme</p>
      )}
      {formId && (
        <div className="flex flex-wrap items-center gap-2">
          {formSource ? (
            <PreviewLabel source={formSource} suffix="Form override" />
          ) : (
            <p className="text-[12px] leading-[18px] text-fg-2">Form override</p>
          )}
        </div>
      )}
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
