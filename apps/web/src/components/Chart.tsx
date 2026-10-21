import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { useTheme } from '../lib/theme';

export type ChartColors = { fg: string; muted: string; line: string; accent: string; agent: string; good: string; bad: string; surface: string };

function readColors(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(`--${k}`).trim();
  return { fg: v('fg'), muted: v('muted'), line: v('line'), accent: v('accent'), agent: v('agent'), good: v('good'), bad: v('bad'), surface: v('surface') };
}

/** ECharts wrapper that rebuilds its options from theme tokens whenever the theme flips. */
export function Chart({ option, height = 240, deps = [] }: { option: (c: ChartColors) => echarts.EChartsOption; height?: number; deps?: unknown[] }) {
  const el = useRef<HTMLDivElement>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const theme = useTheme();
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
