import * as echarts from 'echarts';
import { useEffect, useRef, useState } from 'react';
import { useResolvedTheme } from '../app/theme';
import type { ChartColors, ChartProps } from './Chart';

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function readColors(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(`--${k}`).trim();
  return {
    fg: v('fg'),
    fg2: v('fg-2'),
    muted: v('muted'),
    line: v('line'),
    control: v('control'),
    surface: v('surface'),
    accent: v('accent'),
    viz: [1, 2, 3, 4, 5, 6].map((i) => v(`viz-${i}`)),
    seq: [1, 2, 3, 4, 5].map((i) => v(`seq-${i}`)),
    div: [1, 2, 3, 4, 5, 6, 7].map((i) => v(`div-${i}`)),
  };
}

/** 12/18 labels and a 12/18 tooltip: the chart contract's text roles. */
const label = { color: 'inherit', fontFamily: FONT, fontSize: 12, lineHeight: 18 };

/** The ECharts half of Chart, in its own chunk so pages without a chart do not load it (#60). */
export default function ChartImpl({ option, height = 240, deps = [] }: ChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const theme = useResolvedTheme();
  const [mobile, setMobile] = useState(() => (typeof matchMedia === 'function' ? matchMedia('(max-width: 767px)').matches : false));

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(max-width: 767px)');
    const update = () => setMobile(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart reads CSS colours, so it is rebuilt when the theme or width changes
  useEffect(() => {
    if (!el.current) return;
    const chart = echarts.init(el.current, undefined, { renderer: 'svg' });
    const c = readColors();
    const chartHeight = mobile ? 200 : height;
    const base: Record<string, unknown> = {
      animation: false,
      textStyle: { ...label, color: c.muted, fontFamily: FONT },
      // Quiet grid: at most four horizontal lines, no vertical grid and no bounding axis box.
      grid: { left: 48, right: mobile ? 88 : 112, top: 16, bottom: 32 },
      xAxis: {
        axisLine: { lineStyle: { color: c.line } },
        axisTick: { show: false },
        axisLabel: { ...label, color: c.muted },
        splitLine: { show: false },
      },
      yAxis: {
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...label, color: c.muted },
        splitLine: { lineStyle: { color: c.line, width: 1 } },
        splitNumber: 3,
      },
      tooltip: {
        backgroundColor: c.surface,
        borderColor: c.line,
        borderWidth: 1,
        padding: 12,
        textStyle: { ...label, color: c.fg },
        extraCssText: 'box-shadow: var(--shadow-1); border-radius: 8px; max-width: 280px;',
      },
      aria: { enabled: true },
    };
    // A caller's option merges into the themed defaults one level deep, so `tooltip: { trigger }`
    // keeps the tooltip's colours and type instead of replacing them (#442 review).
    const own = optionRef.current(c) as Record<string, unknown>;
    for (const [key, value] of Object.entries(own)) {
      const prev = base[key];
      base[key] =
        prev && value && typeof prev === 'object' && typeof value === 'object' && !Array.isArray(prev) && !Array.isArray(value)
          ? { ...(prev as object), ...(value as object) }
          : value;
    }
    chart.setOption(base);
    chart.resize({ height: chartHeight });
    const ro = new ResizeObserver(() => chart.resize({ height: chartHeight }));
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [theme, mobile, height, ...deps]);
  return <div ref={el} style={{ height: mobile ? 200 : height, width: '100%' }} />;
}
