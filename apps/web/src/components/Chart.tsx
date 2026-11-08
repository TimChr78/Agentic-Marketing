import type { EChartsOption } from 'echarts';
import { lazy, Suspense } from 'react';
import { Skeleton, SkeletonRegion } from '../ui';

/**
 * Colours read from the v2 tokens: neutral chrome, categorical `viz` series, and the sequential /
 * `seq` and diverging `div` ramps. There is no agent colour: an agent is an identity (bot icon and
 * label), never a chart series or status colour.
 */
export type ChartColors = {
  fg: string;
  fg2: string;
  muted: string;
  line: string;
  control: string;
  surface: string;
  accent: string;
  viz: string[];
  seq: string[];
  div: string[];
};

export type ChartProps = { option: (c: ChartColors) => EChartsOption; height?: number; deps?: unknown[] };

// ECharts is large, and only the demo's overview and analytics use it (#60).
const ChartImpl = lazy(() => import('./ChartImpl'));

/** ECharts wrapper that rebuilds its options from theme tokens whenever the theme flips. */
export function Chart({ option, height = 240, deps = [] }: ChartProps) {
  return (
    <Suspense
      fallback={
        <SkeletonRegion label="Loading chart" geometry="chart" minHeight={height}>
          <Skeleton shape="chart" height={height} />
        </SkeletonRegion>
      }
    >
      <ChartImpl option={option} height={height} deps={deps} />
    </Suspense>
  );
}
