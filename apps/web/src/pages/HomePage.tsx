import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCrumbs } from '../app/page';
import { useWorkspace } from '../app/session';
import {
  checklistEligible,
  checklistView,
  hideChecklist,
  homeChecklistKey,
  readChecklistHidden,
  restoreChecklist,
} from '../features/home/checklist';
import { HomeAttention } from '../features/home/HomeAttention';
import { HomeKpis } from '../features/home/HomeKpis';
import { HomeRunning } from '../features/home/HomeRunning';
import { HomeSection } from '../features/home/HomeSection';
import { OnboardingChecklist } from '../features/home/OnboardingChecklist';
import { useHomeData } from '../features/home/useHomeData';
import { Button, LinkButton } from '../ui/Button';
import { EmptyState, PageHeader } from '../ui/display';
import { pageWidth } from '../ui/layout';
import { formatDateTime } from '../ui/time';

// Home (#447): what needs me, what is running and how it is going. The role only changes the
// order; permissions decide what may be read. Page-level data comes from the shared Home reads,
// and the checklist's four facts are derived from current configuration, never stored on the server.

type SectionKey = 'checklist' | 'attention' | 'running' | 'performance';

function sectionOrder(role: string): SectionKey[] {
  switch (role) {
    case 'owner':
    case 'admin':
      return ['checklist', 'attention', 'running', 'performance'];
    case 'marketer':
      return ['checklist', 'running', 'attention', 'performance'];
    case 'approver':
      return ['attention', 'running', 'performance'];
    default:
      // viewer and any unknown/custom role: performance first, then running, then attention.
      return ['performance', 'running', 'attention'];
  }
}

export default function HomePage() {
  useCrumbs([{ label: 'Home' }]);
  const { workspace, user, can } = useWorkspace();
  const role = workspace.you.role;
  const brandName = workspace.brand?.siteName || workspace.name;
  const key = homeChecklistKey(user.id, workspace.id);
  const [dismissed, setDismissed] = useState(() => readChecklistHidden(key));
  const [forced, setForced] = useState(false);

  useEffect(() => {
    setDismissed(readChecklistHidden(key));
    setForced(false);
  }, [key]);

  const eligible = checklistEligible(role);
  const checklistActive = eligible && !dismissed;
  const home = useHomeData({ workspace, can, checklistActive });
  const view = checklistView({
    brand: home.resources.brand,
    status: home.resources.status,
    profiles: home.resources.profiles,
    domains: workspace.domains,
    can,
  });
  const showChecklist = eligible && (!dismissed || forced) && (!view.allConfirmed || forced);

  const restore = () => {
    restoreChecklist(key);
    setDismissed(false);
    setForced(true);
  };
  const hide = () => {
    hideChecklist(key);
    setDismissed(true);
    setForced(false);
  };

  const footer =
    home.refreshFailed && home.lastLoadedAt
      ? `Last loaded ${formatDateTime(home.lastLoadedAt, { zone: true })}; refresh failed`
      : home.fetchedAt
        ? `Fetched ${formatDateTime(home.fetchedAt, { zone: true })}`
        : 'Fetched time unavailable';

  const restrictedWork = !can('artifacts:read');
  let restrictedShown = false;
  const renderSection = (slot: SectionKey) => {
    switch (slot) {
      case 'checklist':
        if (!showChecklist) return null;
        return (
          <OnboardingChecklist
            key="checklist"
            brandName={brandName}
            view={view}
            can={can}
            linksUrl={workspace.linksUrl}
            readOnly={view.allConfirmed}
            onHide={hide}
            onClose={() => setForced(false)}
            onRetry={{
              brand: () => void home.retry.brand(),
              status: () => void home.retry.status(),
              profiles: () => void home.retry.profiles(),
            }}
          />
        );
      case 'attention':
        if (restrictedWork) {
          if (restrictedShown) return null;
          restrictedShown = true;
          return (
            <HomeSection key="attention" title="Needs attention">
              <EmptyState compact title="Your role cannot view operational work">
                Ask an admin for access.
              </EmptyState>
            </HomeSection>
          );
        }
        return <HomeAttention key="attention" data={home} can={can} />;
      case 'running':
        if (restrictedWork) {
          if (restrictedShown) return null;
          restrictedShown = true;
          return (
            <HomeSection key="running" title="Needs attention">
              <EmptyState compact title="Your role cannot view operational work">
                Ask an admin for access.
              </EmptyState>
            </HomeSection>
          );
        }
        return <HomeRunning key="running" data={home} />;
      case 'performance':
        if (restrictedWork)
          return (
            <HomeSection key="performance" title="E-mail performance">
              <EmptyState compact title="Your role cannot view e-mail performance">
                Ask an admin for access.
              </EmptyState>
            </HomeSection>
          );
        return (
          <HomeKpis
            key="performance"
            resource={home.resources.performance}
            period={home.clock.period}
            onRetry={() => void home.retry.performance()}
          />
        );
    }
  };

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Home"
        description={`${brandName} · your brand at a glance`}
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw size={16} />} loading={home.refreshing} onClick={() => void home.reload()}>
              Refresh
            </Button>
            {can('artifacts:write') && (
              <LinkButton href="/marketing/broadcasts?create=broadcast" variant="primary">
                New broadcast
              </LinkButton>
            )}
          </>
        }
      />

      <div className="space-y-6 lg:space-y-8">{sectionOrder(role).map(renderSection)}</div>

      <div className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[18px] text-muted lg:mt-8">
        <span>{footer}</span>
        {eligible && !showChecklist && (
          <>
            <span aria-hidden>·</span>
            <button type="button" onClick={restore} className="min-h-10 text-accent pointer-coarse:min-h-10 hover:underline md:min-h-0">
              Show setup checklist
            </button>
          </>
        )}
      </div>
    </div>
  );
}
