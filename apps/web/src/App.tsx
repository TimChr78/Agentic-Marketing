import { BarChart3, Bot, CheckCircle2, Globe, LayoutDashboard, Mail, PlugZap, Users, Workflow, X } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { cx } from './components/ui';
import { Copilot } from './copilot/Copilot';
import { startAmbientTraffic } from './mock/live';
import { type Route, routes, useStore } from './mock/store';
import { Analytics } from './screens/Analytics';
import { Approvals } from './screens/Approvals';
import { Journeys } from './screens/Journeys';
import { LiveSite } from './screens/LiveSite';
import { Overview } from './screens/Overview';
import { Profiles } from './screens/Profiles';
import { Setup } from './screens/Setup';

// GrapesJS is large; load it only when the e-mail editor opens.
const EmailEditor = lazy(() => import('./screens/EmailEditor'));

const nav: { route: Route; label: string; icon: typeof Workflow }[] = [
  { route: 'overview', label: 'Overview', icon: LayoutDashboard },
  { route: 'live', label: 'Live site demo', icon: Globe },
  { route: 'journeys', label: 'Journeys', icon: Workflow },
  { route: 'email', label: 'E-mail templates', icon: Mail },
  { route: 'profiles', label: 'Profiles', icon: Users },
  { route: 'analytics', label: 'Analytics', icon: BarChart3 },
  { route: 'approvals', label: 'Approvals', icon: CheckCircle2 },
  { route: 'setup', label: 'Channels & MCP', icon: PlugZap },
];

const fullBleed: Route[] = ['email'];

export default function App() {
  const { route, navigate, copilotOpen, setCopilotOpen, approvals, toasts, dismissToast, openJourneyId } = useStore();
  const pending = approvals.filter((a) => a.status === 'pending').length;

  useEffect(() => {
    const fromHash = location.hash.slice(1) as Route;
    if (routes.includes(fromHash)) navigate(fromHash);
    return startAmbientTraffic();
  }, [navigate]);

  const bleed = fullBleed.includes(route) || (route === 'journeys' && openJourneyId);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Navigation: rail on desktop, scrolling strip on phones */}
      <aside className="shrink-0 border-b border-line bg-surface lg:w-[228px] lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 lg:block lg:px-5 lg:pt-5 lg:pb-4">
          <div>
            <div className="text-[17px] font-bold leading-tight" style={{ fontFamily: 'var(--font-display)' }}>
              agentic<span className="text-accent">·</span>marketing
            </div>
            <div className="text-[11px] text-muted lg:mt-0.5">Demo workspace: Fjeldvej Outdoor</div>
          </div>
          <button
            type="button"
            className="rounded-md bg-agent-soft p-2 text-agent lg:hidden"
            onClick={() => setCopilotOpen(!copilotOpen)}
            aria-label="Toggle copilot"
          >
            <Bot size={18} />
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:flex-col lg:overflow-visible lg:px-3">
          {nav.map(({ route: r, label, icon: Icon }) => (
            <button
              type="button"
              key={r}
              onClick={() => navigate(r, r === 'journeys' ? { journeyId: null } : undefined)}
              className={cx(
                'flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium',
                route === r ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              <Icon size={16} />
              <span>{label}</span>
              {r === 'approvals' && pending > 0 && (
                <span className="num ml-auto rounded-full bg-agent px-1.5 text-[10px] font-bold text-accent-fg">{pending}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="mx-4 mt-6 hidden rounded-md border border-dashed border-line p-3 text-[11px] leading-relaxed text-muted lg:block">
          Demo with sample data. The backend is mocked in the browser; nothing you do here reaches a real workspace.
          {import.meta.env.MODE !== 'single' && (
            <a href="/" className="mt-2 block font-medium text-accent hover:underline">
              Sign in to your workspace
            </a>
          )}
        </div>
        <div className="mt-4 hidden px-3 pb-5 lg:block">
          <button
            type="button"
            onClick={() => setCopilotOpen(!copilotOpen)}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-[13px] font-semibold',
              copilotOpen ? 'border-agent bg-agent-soft text-agent' : 'border-line text-agent hover:bg-agent-soft',
            )}
          >
            <Bot size={16} /> Copilot
            <span className="ml-auto text-[11px] font-normal text-muted">MCP client</span>
          </button>
        </div>
      </aside>

      <main className={cx('min-h-0 min-w-0 flex-1 overflow-auto', !bleed && 'px-4 py-5 lg:px-8 lg:py-7')}>
        <Suspense fallback={<div className="p-8 text-muted">Loading the e-mail editor…</div>}>
          {route === 'overview' && <Overview />}
          {route === 'journeys' && <Journeys />}
          {route === 'email' && <EmailEditor />}
          {route === 'live' && <LiveSite />}
          {route === 'profiles' && <Profiles />}
          {route === 'analytics' && <Analytics />}
          {route === 'approvals' && <Approvals />}
          {route === 'setup' && <Setup />}
        </Suspense>
      </main>

      {copilotOpen && (
        <aside className="fixed inset-0 z-30 flex flex-col bg-surface lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-line">
          <Copilot onClose={() => setCopilotOpen(false)} />
        </aside>
      )}

      <div
        className="pointer-events-none fixed bottom-0 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex items-center gap-3 rounded-md border px-3.5 py-2 text-[13px] font-medium shadow-lg',
              t.tone === 'good' && 'border-good/40 bg-good-soft text-good',
              t.tone === 'agent' && 'border-agent/40 bg-agent-soft text-agent',
              t.tone === 'bad' && 'border-bad/40 bg-bad-soft text-bad',
              t.tone === 'neutral' && 'border-line bg-surface text-fg',
            )}
          >
            {t.text}
            <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
