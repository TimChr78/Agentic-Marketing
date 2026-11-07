import { RefreshCw } from 'lucide-react';
import { Button, formatDateTime, Skeleton } from '../../../ui';
import { estimateSummary } from './model';
import type { AudienceEstimateView } from './useComposerData';

/**
 * The saved audience check (#497). `broadcasts.preview` only reads a saved version, so a dirty
 * composer says to save and keeps the previous result muted and labelled with the version it
 * measured. The number is never scaled to the whole segment.
 */
export function AudienceEstimate({
  estimate,
  template,
  segment,
  dirty,
  savedRevision,
}: {
  estimate: AudienceEstimateView;
  template: string | undefined;
  segment: string | undefined;
  dirty: boolean;
  savedRevision: string;
}) {
  const previous =
    estimate.data && estimate.asOf && estimate.dataVersion !== undefined
      ? {
          ...estimateSummary(estimate.data),
          asOf: formatDateTime(estimate.asOf, { zone: true }),
          version: estimate.dataVersion,
        }
      : undefined;
  const missing = !template || !segment;
  const summary =
    !dirty && !estimate.error && estimate.data && estimate.dataRevision === savedRevision ? estimateSummary(estimate.data) : undefined;
  const asOf = estimate.asOf ? formatDateTime(estimate.asOf, { zone: true }) : null;
  const refreshDisabled = dirty || estimate.loading || missing;

  return (
    <section aria-labelledby="composer-audience-title" className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="composer-audience-title" className="text-[14px] leading-5 font-semibold">
          Audience
        </h3>
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={14} aria-hidden />}
          loading={estimate.loading}
          disabled={refreshDisabled}
          title={dirty ? 'Save the draft to refresh the audience estimate.' : 'Refresh the audience estimate'}
          onClick={estimate.refresh}
        >
          Refresh estimate
        </Button>
      </div>

      {missing ? (
        <p className="mt-2 text-[13px] leading-5 text-fg-2">Choose a template and segment to check the audience.</p>
      ) : dirty ? (
        <div className="mt-2 space-y-1.5" data-audience-state="save-required">
          <p className="text-[13px] leading-5 font-medium text-fg">Save draft to refresh the audience estimate</p>
          {previous && (
            <p className="text-[12px] leading-[18px] text-muted">
              Previous check · Saved v{previous.version} · {previous.headline} · {previous.detail} · as of {previous.asOf}
            </p>
          )}
        </div>
      ) : estimate.error ? (
        <div className="mt-2 space-y-1.5" data-audience-state="error">
          <p role="alert" className="text-[13px] leading-5 text-bad">
            Audience check failed. No current estimate.
          </p>
          <p className="text-[12px] leading-[18px] break-words text-muted">{estimate.error}</p>
          {previous && (
            <p className="text-[12px] leading-[18px] text-muted">
              Previous check · Saved v{previous.version} · {previous.headline} · {previous.detail} · as of {previous.asOf}
            </p>
          )}
          <Button size="sm" variant="ghost" onClick={estimate.refresh}>
            Retry
          </Button>
        </div>
      ) : estimate.loading && !summary ? (
        <div role="status" className="mt-2 space-y-1.5" aria-busy="true">
          <span className="sr-only">Checking the audience</span>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      ) : summary ? (
        <div className="mt-2 space-y-1" data-audience-state="current" aria-live="polite">
          <p className="text-[15px] leading-6 font-semibold text-fg">{summary.headline}</p>
          <p className="text-[12px] leading-[18px] text-fg-2">
            {summary.detail}
            {asOf ? ` · as of ${asOf}` : ''}
          </p>
          {summary.skipped.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] leading-[18px] text-muted">
              {summary.skipped.map((skip) => (
                <li key={skip.reason}>
                  {skip.label}: {skip.count.toLocaleString('en-US')}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div role="status" className="mt-2 space-y-1.5" aria-busy="true">
          <span className="sr-only">Checking the audience</span>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      )}
    </section>
  );
}
