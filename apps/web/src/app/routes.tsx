import { type ComponentType, lazy, useEffect } from 'react';
import { EmptyState, LinkButton } from '../ui';
import { homePath } from './nav';
import { useCrumbs } from './page';
import { match, navigate, useLocation } from './router';
import { useSession } from './session';

type Page = ComponentType<{ params: Record<string, string> }>;
const p = (load: () => Promise<{ default: Page }>) => lazy(load);

// Route table. A route lists the permissions that open it (any one); without them the page is not
// offered in the nav and a deep link explains why instead of failing with 403s.
const ROUTES: { path: string; page: Page; needs?: string[] }[] = [
  { path: '/approvals', page: p(() => import('../pages/approvals/ApprovalsPage')), needs: ['artifacts:read'] },
  { path: '/approvals/:id', page: p(() => import('../pages/approvals/ApprovalsPage')), needs: ['artifacts:read'] },

  { path: '/build/journeys', page: p(() => import('../pages/build/JourneysPage')), needs: ['artifacts:read'] },
  { path: '/build/journeys/:id', page: p(() => import('../pages/build/JourneyPage')), needs: ['artifacts:read'] },
  { path: '/build/broadcasts', page: p(() => import('../pages/build/BroadcastsPage')), needs: ['artifacts:read'] },
  { path: '/build/broadcasts/:id', page: p(() => import('../pages/build/BroadcastPage')), needs: ['artifacts:read'] },
  { path: '/build/forms', page: p(() => import('../pages/build/FormsPage')), needs: ['artifacts:read'] },
  { path: '/build/forms/:id', page: p(() => import('../pages/build/FormPage')), needs: ['artifacts:read'] },
  { path: '/build/segments', page: p(() => import('../pages/build/SegmentsPage')), needs: ['artifacts:read'] },
  { path: '/build/segments/:id', page: p(() => import('../pages/build/SegmentPage')), needs: ['artifacts:read'] },
  { path: '/build/experiences', page: p(() => import('../pages/build/ExperiencesPage')), needs: ['artifacts:read'] },
  { path: '/build/experiences/:id', page: p(() => import('../pages/build/ExperiencePage')), needs: ['artifacts:read'] },
  { path: '/build/prompts', page: p(() => import('../pages/build/PromptsPage')), needs: ['artifacts:read'] },
  { path: '/build/prompts/:id', page: p(() => import('../pages/build/PromptPage')), needs: ['artifacts:read'] },

  { path: '/design/templates', page: p(() => import('../pages/design/TemplatesPage')), needs: ['artifacts:read'] },
  { path: '/design/templates/:id', page: p(() => import('../pages/design/TemplatePage')), needs: ['artifacts:read'] },
  { path: '/design/blocks', page: p(() => import('../pages/design/BlocksPage')), needs: ['artifacts:read'] },
  { path: '/design/blocks/:id', page: p(() => import('../pages/design/BlockPage')), needs: ['artifacts:read'] },
  { path: '/design/assets', page: p(() => import('../pages/design/AssetsPage')), needs: ['artifacts:read'] },
  { path: '/design/hosted-pages', page: p(() => import('../pages/design/HostedPagesPage')), needs: ['artifacts:read'] },
  { path: '/design/brand', page: p(() => import('../pages/design/BrandPage')), needs: ['artifacts:read'] },

  { path: '/audience/people', page: p(() => import('../pages/audience/PeoplePage')), needs: ['profiles:read'] },
  { path: '/audience/people/:id', page: p(() => import('../pages/audience/PersonPage')), needs: ['profiles:read'] },
  { path: '/audience/consent', page: p(() => import('../pages/audience/ConsentPage')), needs: ['profiles:read'] },
  { path: '/audience/imports', page: p(() => import('../pages/audience/ImportsPage')), needs: ['profiles:write'] },

  { path: '/insights/messages', page: p(() => import('../pages/insights/MessagesPage')), needs: ['profiles:read'] },
  { path: '/insights/deliverability', page: p(() => import('../pages/insights/DeliverabilityPage')), needs: ['artifacts:read'] },
  { path: '/insights/journeys', page: p(() => import('../pages/insights/JourneyStatsPage')), needs: ['artifacts:read'] },
  { path: '/insights/ai', page: p(() => import('../pages/insights/AiUsagePage')), needs: ['artifacts:read'] },

  { path: '/settings/providers', page: p(() => import('../pages/settings/ProvidersPage')), needs: ['workspace:admin'] },
  { path: '/settings/integrations', page: p(() => import('../pages/settings/IntegrationsPage')) },
  { path: '/settings/integrations/tokens/:id', page: p(() => import('../pages/settings/IntegrationsPage')) },
  { path: '/settings/secrets', page: p(() => import('../pages/settings/SecretsPage')), needs: ['secrets:read'] },
  { path: '/settings/users', page: p(() => import('../pages/settings/UsersPage')), needs: ['workspace:admin'] },
  { path: '/settings/approval-policy', page: p(() => import('../pages/settings/ApprovalPolicyPage')), needs: ['artifacts:read'] },
  { path: '/settings/purposes', page: p(() => import('../pages/settings/PurposesPage')), needs: ['artifacts:read'] },
  { path: '/settings/workspace', page: p(() => import('../pages/settings/WorkspacePage')), needs: ['workspace:admin'] },
  { path: '/settings/preferences', page: p(() => import('../pages/settings/PreferencesPage')) },

  { path: '/artifacts/:id', page: p(() => import('../pages/artifacts/ArtifactPage')), needs: ['artifacts:read'] },
];

export function Routes() {
  const { path } = useLocation();
  const { can } = useSession();
  useEffect(() => {
    if (path === '/' || path === '/demo-signed-in') navigate(homePath(can), { replace: true });
  }, [path, can]);
  if (path === '/') return null;
  for (const r of ROUTES) {
    const params = match(r.path, path);
    if (!params) continue;
    if (r.needs?.length && !r.needs.some(can)) return <NoAccess />;
    const Page = r.page;
    return <Page key={r.path} params={params} />;
  }
  return <NotFound />;
}

function NotFound() {
  useCrumbs([{ label: 'Not found' }]);
  return (
    <EmptyState title="This page doesn't exist" action={<LinkButton href="/">Go to the start page</LinkButton>}>
      The address may be mistyped, or the item was moved.
    </EmptyState>
  );
}

function NoAccess() {
  const { workspace } = useSession();
  useCrumbs([{ label: 'No access' }]);
  return (
    <EmptyState title="Your role can't open this page" action={<LinkButton href="/">Go to the start page</LinkButton>}>
      You are signed in to {workspace?.name} as {workspace?.you.role}. Ask a workspace admin if you need access.
    </EmptyState>
  );
}
