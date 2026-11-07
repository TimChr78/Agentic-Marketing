import { useId } from 'react';

// `ui/charts.tsx` draws series but has no threshold-line option (#508). The approved contract asks
// for today's bounce/complaint thresholds as labelled dashed lines, so this surface owns a small
// scoped SVG chart. It follows the shared chart contract: straight 2 px lines, gaps stay gaps, at
// most four date ticks, at most four gridlines, a visible table elsewhere with the same values, and
// text labels so the lines never rely on colour.

const WIDTH = 800;
const HEIGHT = 240;
const LEFT = 56;
const RIGHT = 24;
const TOP = 30;
const BOTTOM = 40;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

export interface ThresholdLine {
  /** Stable id used by tests and the table note. */
  id: string;
  /** Threshold as a percentage, e.g. 5 for 5%. */
  value: number;
  label: string;
  tone: 'stop' | 'warn';
  labelPosition: 'above' | 'below';
}

function tickLabel(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function dateIndexes(length: number): number[] {
  if (length <= 1) return [0];
  const candidates = [0, Math.round((length - 1) / 3), Math.round(((length - 1) * 2) / 3), length - 1];
  return [...new Set(candidates)];
}

/** A line or area chart whose y axis is percent and whose policy lines are labelled. */
export function ThresholdChart({
  title,
  subtitle,
  labels,
  values,
  thresholds,
  summary,
}: {
  title: string;
  subtitle: string;
  labels: string[];
  values: (number | null)[];
  thresholds: ThresholdLine[];
  summary: string;
}) {
  const id = useId().replace(/:/g, '');
  const headingId = `${id}-heading`;
  const svgTitleId = `${id}-title`;
  const descId = `${id}-desc`;
  const observed = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const maxObserved = observed.length ? Math.max(...observed) : 0;
  const maxThreshold = thresholds.length ? Math.max(...thresholds.map((line) => line.value)) : 0;
  const yMax = Math.max(1, Math.ceil(Math.max(maxObserved, maxThreshold) * 1.1 * 2) / 2);
  const y = (value: number) => TOP + PLOT_HEIGHT - (value / yMax) * PLOT_HEIGHT;
  const x = (index: number) => (labels.length <= 1 ? LEFT + PLOT_WIDTH / 2 : LEFT + (index / (labels.length - 1)) * PLOT_WIDTH);
  const ticks = [0, yMax / 3, (yMax * 2) / 3, yMax];
  const tickIndexes = new Set(dateIndexes(labels.length));

  // A null value is a real gap (zero volume or below evaluation volume); flushing breaks the line.
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${x(index).toFixed(2)},${y(value).toFixed(2)}`);
  });
  if (current.length) segments.push(current.join(' '));

  return (
    <figure aria-labelledby={headingId} className="min-w-0 bg-surface">
      <h3 id={headingId} className="text-[16px] leading-6 font-semibold">
        {title}
      </h3>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">{subtitle}</p>
      <section
        className="mt-4 overflow-x-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable chart canvas must be reachable with the keyboard to scroll it
        tabIndex={0}
        aria-label={`${title} chart; scroll horizontally on narrow screens`}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-auto min-w-[560px] w-full"
          role="img"
          aria-labelledby={`${svgTitleId} ${descId}`}
        >
          <title id={svgTitleId}>{title}</title>
          <desc id={descId}>{summary}</desc>
          <g>
            {ticks.map((tick) => (
              <line key={`grid-${tick}`} x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeWidth={1} />
            ))}
            {ticks.map((tick) => (
              <text key={`tick-${tick}`} x={LEFT - 8} y={y(tick) + 4} textAnchor="end" fill="var(--muted)" fontSize={12}>
                {tickLabel(tick)}
              </text>
            ))}
            {[...tickIndexes].map((index) => {
              const label = labels[index] ?? '';
              return (
                <text
                  key={`date-${label}`}
                  x={x(index)}
                  y={HEIGHT - 12}
                  textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}
                  fill="var(--muted)"
                  fontSize={12}
                >
                  {label}
                </text>
              );
            })}
            {thresholds.map((line) => (
              <g key={line.id}>
                <line
                  data-threshold={line.id}
                  x1={LEFT}
                  x2={WIDTH - RIGHT}
                  y1={y(line.value)}
                  y2={y(line.value)}
                  stroke={line.tone === 'stop' ? 'var(--warn)' : 'var(--fg-2)'}
                  strokeWidth={2}
                  strokeDasharray={line.tone === 'stop' ? '8 6' : '3 5'}
                />
                <text
                  x={LEFT + 8}
                  y={line.labelPosition === 'above' ? y(line.value) - 7 : y(line.value) + 16}
                  fill={line.tone === 'stop' ? 'var(--warn)' : 'var(--fg-2)'}
                  fontSize={12}
                >
                  {line.label}
                </text>
              </g>
            ))}
            {segments.map((points, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional runs of the same series, never reordered
              <polyline key={index} points={points} fill="none" stroke="var(--viz-2)" strokeWidth={2} strokeLinejoin="round" />
            ))}
            {labels.length <= 12 &&
              values.map((value, index) =>
                value === null || !Number.isFinite(value) ? null : (
                  <circle key={`point-${labels[index] ?? index}`} cx={x(index)} cy={y(value)} r={3} fill="var(--viz-2)" />
                ),
              )}
          </g>
        </svg>
      </section>
      <figcaption className="mt-2 text-[12px] leading-[18px] text-fg-2">{summary}</figcaption>
    </figure>
  );
}
