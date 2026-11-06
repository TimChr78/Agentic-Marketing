import type { ChartDataState, KpiDataState } from '../ui/charts';
import type { Tone } from '../ui/display';

// Metric data states (#437, DESIGN.md v2 → Chart contract data-state table). A rate needs a real
// denominator and enough volume before it may look healthy. Zero observations are not "ok", and a
// source that cannot evaluate its own threshold says so instead of guessing.

export type MetricDataState = 'no-data' | 'below-volume' | 'healthy' | 'warning' | 'paused' | 'suppressed';

export interface DataStateInput {
  /** The observed value; null when the source has no value for the period. */
  value: number | null;
  /** The denominator (delivered people, sends, evaluated messages) behind the value. */
  sampleSize: number | null | undefined;
  /** The source's own minimum evaluation volume; never invented by the UI. */
  minSample?: number | null;
  /** The source reports collection paused. */
  paused?: boolean;
  /** The source suppressed the value to protect a small group (k-anonymity). */
  suppressed?: boolean;
  /** The source's own evaluation says warning (e.g. deliverability status `warn`). */
  warning?: boolean;
}

/**
 * The one data-state decision used by metric tiles, charts and delivery health.
 *
 * Precedence: suppression and pause are facts about availability; no sample or no value is no data;
 * a sample below the source's threshold is below evaluation volume; only then may the source's own
 * warning flag apply. Healthy therefore always has an observed value and a non-zero sample.
 */
export function dataState({ value, sampleSize, minSample, paused, suppressed, warning }: DataStateInput): MetricDataState {
  if (suppressed) return 'suppressed';
  if (paused) return 'paused';
  if (value === null || sampleSize === null || sampleSize === undefined || sampleSize <= 0) return 'no-data';
  if (typeof minSample === 'number' && sampleSize < minSample) return 'below-volume';
  return warning ? 'warning' : 'healthy';
}

export const DATA_STATE: Record<MetricDataState, { label: string; tone: Tone }> = {
  'no-data': { label: 'No data', tone: 'neutral' },
  'below-volume': { label: 'Below evaluation volume', tone: 'neutral' },
  healthy: { label: 'Healthy', tone: 'good' },
  warning: { label: 'Warning', tone: 'warn' },
  paused: { label: 'Paused', tone: 'neutral' },
  suppressed: { label: 'Suppressed', tone: 'neutral' },
};

/** Copy for the state, with the sample and threshold it was evaluated against. */
export function dataStateCopy(
  state: MetricDataState,
  input: { sampleSize?: number | null; minSample?: number | null; noData?: string } = {},
): string {
  const sample = input.sampleSize ?? 0;
  switch (state) {
    case 'no-data':
      return input.noData ?? 'No data in this period.';
    case 'below-volume':
      return input.minSample !== null && input.minSample !== undefined
        ? `Below evaluation volume · ${sample.toLocaleString()} / ${input.minSample.toLocaleString()} required`
        : 'Below evaluation volume.';
    case 'suppressed':
      return 'Suppressed · fewer than 5 people';
    case 'paused':
      return 'Collection paused.';
    case 'warning':
      return 'Above the warning threshold.';
    case 'healthy':
      return input.minSample !== null && input.minSample !== undefined
        ? `Evaluated on ${sample.toLocaleString()} · threshold ${input.minSample.toLocaleString()}.`
        : 'Evaluated on the period’s observed sample.';
  }
}

/** KpiTile renders healthy and warning as populated values; the pill carries the evaluation words. */
export function kpiStateOf(state: MetricDataState): KpiDataState {
  switch (state) {
    case 'no-data':
      return 'no-data';
    case 'below-volume':
      return 'below-volume';
    case 'suppressed':
      return 'suppressed';
    case 'healthy':
    case 'warning':
    case 'paused':
      return 'populated';
  }
}

/** Charts keep the value for a warning or a paused source; only absence removes the plot. */
export function chartStateOf(state: MetricDataState): ChartDataState {
  switch (state) {
    case 'no-data':
      return 'no-data';
    case 'below-volume':
      return 'below-volume';
    case 'suppressed':
      return 'suppressed';
    case 'healthy':
    case 'warning':
    case 'paused':
      return 'populated';
  }
}
