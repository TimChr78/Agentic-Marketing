import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';
import { useTheme } from '../lib/theme';
import type { ChartColors, ChartProps } from './Chart';

function readColors(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(`--${k}`).trim();
  return {
    fg: v('fg'),
    muted: v('muted'),
    line: v('line'),
    accent: v('accent'),
    agent: v('agent'),
    good: v('good'),
    bad: v('bad'),
    surface: v('surface'),
  };
}

/** The ECharts half of Chart, in its own chunk so pages without a chart do not load it (#60). */
export default function ChartImpl({ option, height = 240, deps = [] }: ChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const theme = useTheme();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart reads CSS colours, so it is rebuilt when the theme changes
  useEffect(() => {
    if (!el.current) return;
    const chart = echarts.init(el.current, undefined, { renderer: 'svg' });
    const c = readColors();
    chart.setOption({
      textStyle: { color: c.muted, fontFamily: 'IBM Plex Sans, system-ui, sans-serif' },
      grid: { left: 8, right: 12, top: 28, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.line, textStyle: { color: c.fg } },
      ...optionRef.current(c),
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ...deps]);
  return <div ref={el} style={{ height, width: '100%' }} />;
}
