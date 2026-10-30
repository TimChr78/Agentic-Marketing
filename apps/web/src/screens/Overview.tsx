import { ArrowRight, Bot, Globe, Mail, ShieldCheck, Workflow } from 'lucide-react';
import { Chart } from '../components/Chart';
import { AuthorBadge, Card, dkk, Kpi, PageHeader, Pill, timeAgo } from '../components/ui';
import { DEMO_PERSONA } from '../mock/seed';
import { useStore } from '../mock/store';
import { pageWidth } from '../ui';

const tour = [
  {
    icon: Globe,
    title: 'Browse the demo shop',
    text: 'Accept cookies, view three trail shoes and watch the hero change in-session.',
    route: 'live' as const,
  },
  {
    icon: Bot,
    title: 'Ask the copilot',
    text: '“Build a win-back journey for customers inactive 60 days”. It uses the same tools an MCP client gets.',
    copilot: true,
  },
  {
    icon: ShieldCheck,
    title: 'Review the agent’s change',
    text: 'Agent-authored journeys wait for a human. Diff, approve, publish.',
    route: 'approvals' as const,
  },
  {
    icon: Workflow,
    title: 'Simulate a customer',
    text: 'Open a journey and dry-run it for one profile with a virtual clock.',
    route: 'journeys' as const,
  },
];

/** Greet the viewer by their own clock, not a fixed afternoon (#110). */
function greeting(date = new Date()) {
  const hour = date.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function Overview() {
  const { daily, journeys, approvals, events, audit, navigate, setCopilotOpen } = useStore();
  const sum = (k: 'sent' | 'clicks' | 'conversions' | 'revenue') => daily.reduce((a, d) => a + d[k], 0);
  const lastMinute = events.filter((e) => Date.now() - e.at < 60_000);
  const pending = approvals.filter((a) => a.status === 'pending');
  const agentActivity = audit.filter((a) => a.principal.type === 'agent').slice(0, 5);

  return (
    <div className={pageWidth('default')}>
      <PageHeader eyebrow="Overview · last 30 days" title={`${greeting()}, ${DEMO_PERSONA.name}`} />

      <Card className="mb-5 grid grid-cols-2 divide-line md:grid-cols-5 md:divide-x">
        <Kpi label="Messages sent" value={sum('sent').toLocaleString('en')} delta={4.2} />
        <Kpi label="Click rate" value={`${((sum('clicks') / sum('sent')) * 100).toFixed(1)}%`} delta={-0.4} />
        <Kpi label="Attributed orders" value={sum('conversions').toLocaleString('en')} delta={7.9} />
        <Kpi label="Revenue influenced" value={dkk(sum('revenue'))} delta={11.3} />
        <Kpi label="Events / min" value={lastMinute.length.toString()} hint="live, ingest p95 14 ms" />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Try the demo" className="lg:row-span-2">
          <ol className="divide-y divide-line">
            {tour.map((t, i) => (
              <li key={t.title}>
                <button
                  type="button"
                  className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-surface-2"
                  onClick={() => (t.copilot ? setCopilotOpen(true) : navigate(t.route!))}
                >
                  <span className="num mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-bold text-accent">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-semibold">
                      <t.icon size={15} className="text-muted" /> {t.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-muted">{t.text}</span>
                  </span>
                  <ArrowRight size={16} className="mt-1 text-muted" />
                </button>
              </li>
            ))}
          </ol>
          <div className="border-t border-line px-4 py-3">
            <div className="eyebrow mb-2">Revenue influenced per day (DKK)</div>
            <Chart
              height={150}
              deps={[daily]}
              option={(c) => ({
                grid: { left: 4, right: 4, top: 8, bottom: 4, containLabel: true },
                xAxis: {
                  type: 'category',
                  data: daily.map((d) => d.day),
                  axisLine: { lineStyle: { color: c.line } },
                  axisTick: { show: false },
                  axisLabel: { interval: 6 },
                },
                yAxis: {
                  type: 'value',
                  splitLine: { lineStyle: { color: c.line } },
                  axisLabel: { formatter: (v: number) => `${v / 1000}k` },
                },
                series: [
                  {
                    type: 'line',
                    data: daily.map((d) => d.revenue),
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { color: c.accent, width: 2 },
                    areaStyle: { color: c.accent, opacity: 0.12 },
                  },
                ],
              })}
            />
          </div>
        </Card>

        <Card
          title="Journeys"
          action={
            <button type="button" className="text-[12px] text-accent" onClick={() => navigate('journeys', { journeyId: null })}>
              All journeys
            </button>
          }
        >
          <ul className="divide-y divide-line">
            {journeys.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
                  onClick={() => navigate('journeys', { journeyId: j.id })}
                >
                  <Workflow size={15} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate font-medium">{j.name}</span>
                  <span className="num text-[12px] text-muted">{j.metrics.active.toLocaleString('en')} active</span>
                  <Pill tone={j.status === 'live' ? 'good' : j.status === 'draft' ? 'agent' : 'neutral'}>{j.status}</Pill>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Waiting for you" action={<Pill tone={pending.length ? 'agent' : 'good'}>{pending.length} pending</Pill>}>
          <ul className="divide-y divide-line">
            {pending.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
                  onClick={() => navigate('approvals')}
                >
                  {a.artifactType === 'journey' ? (
                    <Workflow size={15} className="mt-0.5 text-muted" />
                  ) : (
                    <Mail size={15} className="mt-0.5 text-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {a.artifactName} v{a.toVersion}
                    </span>
                    <span className="block truncate text-[12px] text-muted">{a.summary}</span>
                  </span>
                  <AuthorBadge author={a.requestedBy} />
                </button>
              </li>
            ))}
            {!pending.length && <li className="px-4 py-4 text-[13px] text-muted">Nothing to review.</li>}
          </ul>
          {agentActivity.length > 0 && (
            <div className="border-t border-line px-4 py-3">
              <div className="eyebrow mb-2">Recent agent activity</div>
              <ul className="space-y-1 text-[12px]">
                {agentActivity.map((a) => (
                  <li key={a.id} className="flex gap-2">
                    <code className="font-mono text-agent">{a.command}</code>
                    <span className="min-w-0 flex-1 truncate text-muted">{a.summary}</span>
                    <span className="text-muted">{timeAgo(a.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
