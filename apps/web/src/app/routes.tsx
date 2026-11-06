import { type ComponentType, lazy, useEffect } from 'react';
import { EmptyState, LinkButton } from '../ui';
import { SettingsLayout } from '../ui/SettingsLayout';
import { useCrumbs } from './page';
import { redirectTarget } from './redirects';
import { match, navigate, useLocation } from './router';
import { useSession } from './session';

type Page = ComponentType<{ params: Record<string, string> }>;
const p = (load: () => Promise<{ default: Page }>) => lazy(load);

const HomePage = p(() => import('../pages/HomePage'));

interface RouteDef {
  path: string;
  page: Page;
  needs?: string[];
  /** Renders inside the Settings secondary navigation (200 px + body). */
  settings?: boolean;
}

// Route table (#446). A route lists the permissions that open it (any one); without them the page
// is not offered in the nav and a deep link explains why instead of failing with 403s. Merged homes
// are one route with tabs: `?tab=` is read by the page adapter, so no nested competing navigation.
const ROUTES: RouteDef[] = [
  { path: '/', page: HomePage },

  { path: '/approvals', page: p(() => import('../pages/approvals/ApprovalsPage')), needs: ['artifacts:read'] },
  { path: '/approvals/:id', page: p(() => import('../pages/approvals/ApprovalsPage')), needs: ['artifacts:read'] },

  { path: '/work/agents', page: p(() => import('../pages/settings/AgentsPage')), needs: ['artifacts:read'] },
  { path: '/work/agents/library/:id', page: p(() => import('../pages/build/PromptPage')), needs: ['artifacts:read'] },
  { path: '/work/agents/:id', page: p(() => import('../pages/settings/AgentPage')), needs: ['artifacts:read'] },

  { path: '/marketing/campaigns', page: p(() => import('../pages/build/CampaignsPage')), needs: ['artifacts:read'] },
  { path: '/marketing/campaigns/:id', page: p(() => import('../pages/build/CampaignPage')), needs: ['artifacts:read'] },
  { path: '/marketing/broadcasts', page: p(() => import('../pages/build/BroadcastsPage')), needs: ['artifacts:read'] },
  { path: '/marketing/broadcasts/:id', page: p(() => import('../pages/build/BroadcastPage')), needs: ['artifacts:read'] },
  { path: '/marketing/journeys', page: p(() => import('../pages/build/JourneysPage')), needs: ['artifacts:read'] },
  // The Report tab itself is task B's ArtifactDetailPage slot (#448): it mounts JourneyStatsPage
  // for `?tab=report`. This route is the stable seam for that hook.
  { path: '/marketing/journeys/:id', page: p(() => import('../pages/build/JourneyPage')), needs: ['artifacts:read'] },
  { path: '/marketing/experiences', page: p(() => import('../pages/build/ExperiencesPage')), needs: ['artifacts:read'] },
  { path: '/marketing/experiences/:id', page: p(() => import('../pages/build/ExperiencePage')), needs: ['artifacts:read'] },

  { path: '/audience/people', page: p(() => import('../pages/audience/PeoplePage')), needs: ['profiles:read', 'profiles:write'] },
  { path: '/audience/people/:id', page: p(() => import('../pages/audience/PersonPage')), needs: ['profiles:read'] },
  { path: '/audience/segments', page: p(() => import('../pages/build/SegmentsPage')), needs: ['artifacts:read'] },
  { path: '/audience/segments/:id', page: p(() => import('../pages/build/SegmentPage')), needs: ['artifacts:read'] },
  { path: '/audience/forms', page: p(() => import('../pages/build/FormsPage')), needs: ['artifacts:read'] },
  { path: '/audience/forms/:id', page: p(() => import('../pages/build/FormPage')), needs: ['artifacts:read'] },
  { path: '/audience/consent', page: p(() => import('../pages/audience/ConsentPage')), needs: ['profiles:read', 'artifacts:read'] },

  { path: '/content/templates', page: p(() => import('../pages/design/TemplatesPage')), needs: ['artifacts:read'] },
  {
    path: '/content/templates/blocks/:id',
    page: p(() => import('../pages/design/BlockPage')),
    needs: ['artifacts:read'],
  },
  { path: '/content/templates/:id', page: p(() => import('../pages/design/TemplatePage')), needs: ['artifacts:read'] },
  { path: '/content/assets', page: p(() => import('../pages/design/AssetsPage')), needs: ['artifacts:read'] },
  { path: '/content/brand', page: p(() => import('../pages/design/BrandPage')), needs: ['artifacts:read'] },

  { path: '/insights/analytics', page: p(() => import('../pages/insights/AnalyticsPage')), needs: ['artifacts:read'] },
  { path: '/insights/messages', page: p(() => import('../pages/insights/MessagesPage')), needs: ['profiles:read'] },
  { path: '/insights/deliverability', page: p(() => import('../pages/insights/DeliverabilityPage')), needs: ['artifacts:read'] },
  { path: '/insights/alerts', page: p(() => import('../pages/insights/AlertsPage')), needs: ['artifacts:read'] },

  { path: '/settings', page: p(() => import('../pages/settings/SettingsPage')) },
  { path: '/settings/workspace', page: p(() => import('../pages/settings/WorkspacePage')), needs: ['workspace:admin'], settings: true },
  { path: '/settings/providers', page: p(() => import('../pages/settings/ProvidersPage')), needs: ['workspace:admin'], settings: true },
  { path: '/settings/integrations', page: p(() => import('../pages/settings/IntegrationsPage')), settings: true },
  {
    path: '/settings/integrations/tokens/:id',
    page: p(() => import('../pages/settings/IntegrationsPage')),
    settings: true,
  },
  { path: '/settings/secrets', page: p(() => import('../pages/settings/SecretsPage')), needs: ['secrets:read'], settings: true },
  { path: '/settings/users', page: p(() => import('../pages/settings/UsersPage')), needs: ['workspace:admin'], settings: true },
  {
    path: '/settings/approval-policy',
    page: p(() => import('../pages/settings/ApprovalPolicyPage')),
    needs: ['artifacts:read'],
    settings: true,
  },

  { path: '/preferences', page: p(() => import('../pages/PreferencesPage')) },
  { path: '/create', page: p(() => import('../pages/CreatePage')) },

  { path: '/artifacts/:id', page: p(() => import('../pages/artifacts/ArtifactPage')), needs: ['artifacts:read'] },
];

function PageRoute({ route, params }: { route: RouteDef; params: Record<string, string> }) {
  const Page = route.page;
  const body = <Page key={route.path} params={params} />;
  return route.settings ? <SettingsLayout>{body}</SettingsLayout> : body;
}

export function Routes() {
  const { path, search } = useLocation();
  const { can } = useSession();
  // Redirect before mounting a page, so a legacy URL never fetches the old page. The hash is kept
  // even though the router's render snapshot does not read it.
  const redirect = redirectTarget(path, search, typeof location === 'undefined' ? '' : location.hash);
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);
  if (redirect) return null;

  for (const r of ROUTES) {
    const params = match(r.path, path);
    if (!params) continue;
    if (r.needs?.length && !r.needs.some(can)) return <NoAccess />;
    return <PageRoute route={r} params={params} />;
  }
  return <NotFound />;
}

function NotFound() {
  useCrumbs([{ label: 'Not found' }]);
  return (
    <EmptyState title="This page doesn't exist" action={<LinkButton href="/">Go to Home</LinkButton>}>
      The address may be mistyped, or the item was moved.
    </EmptyState>
  );
}

function NoAccess() {
  const { workspace } = useSession();
  useCrumbs([{ label: 'No access' }]);
  return (
    <EmptyState title="Your role can't open this page" action={<LinkButton href="/">Go to Home</LinkButton>}>
      You are signed in to {workspace?.name} as {workspace?.you.role}. Ask a workspace admin if you need access.
    </EmptyState>
  );
}
