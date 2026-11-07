import { lazy, Suspense } from 'react';
import { LoadingBlock } from '../../ui';

// The report entry point (#500). The tab's active/authorized shell is lazy so this module stays
// importable for its pure four-tile contract helper without loading the session and theme
// singletons; the Report tab itself imports `BroadcastReport({artifactId, active})` unchanged.

const ReportEntry = lazy(() => import('./report/ReportEntry'));

type LegacyMeasure = 'email.sent' | 'email.delivered' | 'email.clicked' | 'email.click_rate';

export interface BroadcastReportView {
  /** Only an observed zero (not a suppressed or unavailable null) means no sends. */
  noSends: boolean;
  ratePercent: number | null;
  rateAvailable: boolean;
  rateExplanation?: string;
  rateDataState: 'populated' | 'suppressed' | 'no-data';
  /** Why a count tile is null: suppressed or simply unavailable, never "No sends". */
  countExplanation: (value: number | null) => string | undefined;
}

/**
 * The four-tile semantics shared with the Phase 24 tests: a suppressed or missing value is never
 * shown as zero. The Phase 25 report reads the wider ten-measure totals through `report/model.ts`.
 */
export function reportViewOf(values: Record<LegacyMeasure, number | null>, suppressed: number): BroadcastReportView {
  const sent = values['email.sent'];
  const delivered = values['email.delivered'];
  const rateValue = values['email.click_rate'];
  const noSends = sent === 0;
  const ratePercent = rateValue === null ? null : Math.round(rateValue * 1000) / 10;
  const hasDelivered = delivered !== null && delivered > 0;
  const rateAvailable = ratePercent !== null && hasDelivered;

  let rateExplanation: string | undefined;
  if (!rateAvailable) {
    if (suppressed > 0) rateExplanation = 'Suppressed · fewer than 5 people';
    else if (noSends) rateExplanation = 'No sends in this period';
    else if (delivered === 0) rateExplanation = 'No delivered people to divide by';
    else rateExplanation = 'Unavailable in this period';
  }

  return {
    noSends,
    ratePercent,
    rateAvailable,
    rateExplanation,
    rateDataState: rateAvailable ? 'populated' : suppressed > 0 ? 'suppressed' : 'no-data',
    countExplanation: (value) =>
      value !== null
        ? noSends
          ? 'No sends in this period'
          : undefined
        : suppressed > 0
          ? 'Suppressed · fewer than 5 people'
          : 'Unavailable in this period',
  };
}

export function BroadcastReport({ artifactId, active }: { artifactId: string; active: boolean }) {
  if (!active) return null;
  return (
    <Suspense
      fallback={
        <div aria-busy="true">
          <LoadingBlock lines={5} label="Loading report" />
        </div>
      }
    >
      <ReportEntry artifactId={artifactId} />
    </Suspense>
  );
}
