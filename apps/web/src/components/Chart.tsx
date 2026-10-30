import type { EChartsOption } from 'echarts';
import { lazy, Suspense } from 'react';
import { LoadingBlock } from '../ui';

export type ChartColors = {
  fg: string;
  muted: string;
  line: string;
  accent: string;
  agent: string;
  good: string;
  bad: string;
  surface: string;
};

export type ChartProps = { option: (c: ChartColors) => EChartsOption; height?: number; deps?: unknown[] };

// ECharts is large, and only the demo's overview and analytics use it (#60).
const ChartImpl = lazy(() => import('./ChartImpl'));

/** ECharts wrapper that rebuilds its options from theme tokens whenever the theme flips. */
export function Chart({ option, height = 240, deps = [] }: ChartProps) {
  return (
    <Suspense
      fallback={
        <div style={{ height }}>
          <LoadingBlock lines={4} label="Loading chart" />
        </div>
      }
    >
      <ChartImpl option={option} height={height} deps={deps} />
    </Suspense>
  );
}
