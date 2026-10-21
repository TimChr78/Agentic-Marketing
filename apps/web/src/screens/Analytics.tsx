import { useState } from 'react';
import { useStore } from '../mock/store';
import { Card, Kpi, PageHeader, Pill, cx, dkk } from '../components/ui';
import { Chart } from '../components/Chart';

const funnelJourneys = ['jrn_cart', 'jrn_welcome'] as const;

export function Analytics() {
  const { daily, journeys, experiences } = useStore();
  const [jid, setJid] = useState<(typeof funnelJourneys)[number]>('jrn_cart');
  const j = journeys.find((x) => x.id === jid)!;
  const steps = (j.versions.find((v) => v.state === 'published') ?? j.versions[0]).nodes.filter((n) => n.stats && n.kind !== 'wait');
  const sum = (k: 'sent' | 'delivered' | 'clicks' | 'unsubscribes' | 'conversions' | 'revenue' | 'events') => daily.reduce((a, d) => a + d[k], 0);

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow="Built-in analytics · ClickHouse" title="Analytics">
        <Pill tone="neutral">Last 30 days</Pill>
      </PageHeader>

      <Card className="mb-5 grid grid-cols-2 md:grid-cols-6 md:divide-x md:divide-line">
        <Kpi label="Events ingested" value={`${(sum('events') / 1e6).toFixed(2)} M`} />
        <Kpi label="Delivered" value={`${((sum('delivered') / sum('sent')) * 100).toFixed(1)}%`} />
        <Kpi label="Click rate" value={`${((sum('clicks') / sum('sent')) * 100).toFixed(2)}%`} delta={-0.4} />
        <Kpi label="Unsubscribe" value={`${((sum('unsubscribes') / sum('sent')) * 100).toFixed(2)}%`} />
        <Kpi label="Orders" value={sum('conversions').toLocaleString('en')} delta={7.9} />
        <Kpi label="Revenue" value={dkk(sum('revenue'))} delta={11.3} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="E-mail engagement per day">
          <div className="px-2 pb-2">
            <Chart
              deps={[daily]}
              option={(c) => ({
                legend: { top: 0, right: 8, textStyle: { color: c.muted }, itemWidth: 12, itemHeight: 8 },
                xAxis: { type: 'category', data: daily.map((d) => d.day), axisLine: { lineStyle: { color: c.line } }, axisTick: { show: false }, axisLabel: { interval: 5 } },
                yAxis: [
                  { type: 'value', splitLine: { lineStyle: { color: c.line } } },
                  { type: 'value', splitLine: { show: false }, axisLabel: { formatter: '{value}%' } },
                ],
                series: [
                  { name: 'Delivered', type: 'bar', data: daily.map((d) => d.delivered), itemStyle: { color: c.line } },
                  {
                    name: 'Click rate',
                    type: 'line',
                    yAxisIndex: 1,
                    smooth: true,
                    symbol: 'none',
                    data: daily.map((d) => +((d.clicks / d.sent) * 100).toFixed(2)),
                    lineStyle: { color: c.accent, width: 2 },
                  },
                ],
              })}
            />
          </div>
        </Card>

        <Card
          title="Journey funnel"
          action={
            <div className="flex gap-1">
              {funnelJourneys.map((id) => (
                <button key={id} onClick={() => setJid(id)} className={cx('rounded px-2 py-0.5 text-[12px]', jid === id ? 'bg-accent-soft font-semibold text-accent' : 'text-muted')}>
                  {journeys.find((x) => x.id === id)?.name}
                </button>
              ))}
            </div>
          }
        >
          <div className="px-2 pb-2">
            <Chart
              deps={[jid]}
              option={(c) => ({
                grid: { left: 8, right: 40, top: 8, bottom: 4, containLabel: true },
                tooltip: { trigger: 'item', backgroundColor: c.surface, borderColor: c.line, textStyle: { color: c.fg } },
                xAxis: { type: 'value', splitLine: { lineStyle: { color: c.line } } },
                yAxis: { type: 'category', inverse: true, data: steps.map((s) => s.label), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.fg, width: 150, overflow: 'truncate' } },
                series: [
                  {
                    type: 'bar',
                    data: steps.map((s) => ({ value: s.stats!.entered, itemStyle: { color: s.kind.startsWith('ai') ? c.agent : s.kind === 'goal' ? c.good : c.accent } })),
                    label: { show: true, position: 'right', color: c.muted, formatter: (p: { value?: unknown }) => Number(p.value).toLocaleString('en') },
                    barMaxWidth: 18,
                  },
                ],
              })}
            />
          </div>
          <div className="border-t border-line px-4 py-2.5 text-[12px] text-muted">
            Conversion <b className="text-fg">{j.metrics.conversion}%</b> · uplift vs 10% holdout <b className="text-good">+{j.metrics.holdoutUplift} pts</b> — the incremental effect, not just attributed orders.
          </div>
        </Card>

        <Card title="Experiment: cart reminder incentive (A/B)">
          <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
            {[
              { name: 'A · 10% off', sent: 872, conv: 118, prob: 0.91 },
              { name: 'B · Free shipping', sent: 873, conv: 97, prob: 0.09 },
            ].map((v) => (
              <div key={v.name} className="rounded-md border border-line p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{v.name}</span>
                  {v.prob > 0.5 && <Pill tone="good">leading</Pill>}
                </div>
                <div className="num mt-2 text-[24px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                  {((v.conv / v.sent) * 100).toFixed(1)}%
                </div>
                <div className="num text-[12px] text-muted">
                  {v.conv} orders of {v.sent} · P(best) {(v.prob * 100).toFixed(0)}%
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-surface-2">
                  <div className="h-1.5 rounded-full bg-accent" style={{ width: `${v.prob * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="px-4 pb-3 text-[12px] text-muted">Sequential test, 95% credible interval for the difference: +0.4 to +4.4 pts. Stop rule reached in 3 more days.</p>
        </Card>

        <Card title="Web personalization">
          <ul className="divide-y divide-line">
            {experiences.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{x.name}</div>
                  <div className="truncate text-[12px] text-muted">{x.targeting}</div>
                </div>
                <div className="num text-right text-[12px] text-muted">
                  {x.exposures.toLocaleString('en')} exposures
                  <div className="text-[14px] font-semibold text-good">+{x.uplift}% CTR</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-4 py-2.5 text-[12px] text-muted">
            Raw web analytics are forwarded to <b className="text-fg">Umami (self-hosted)</b>; dashboards in Metabase or Grafana can read the curated ClickHouse views.
          </div>
        </Card>
      </div>
    </div>
  );
}
