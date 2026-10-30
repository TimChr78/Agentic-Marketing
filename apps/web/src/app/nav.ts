import { BarChart3, Blocks, Brush, CheckSquare, type LucideIcon, Settings, Users } from 'lucide-react';

// The information architecture (#34). Each entry names the permission it needs; entries the
// person's role cannot use are hidden, so the nav never leads to a page full of 403s.

export interface NavItem {
  path: string;
  label: string;
  /** Any one of these permissions shows the entry. Empty: everyone in the workspace. */
  needs: string[];
}
export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  path?: string;
  needs?: string[];
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    key: 'build',
    label: 'Build',
    icon: Blocks,
    items: [
      { path: '/build/journeys', label: 'Journeys', needs: ['artifacts:read'] },
      { path: '/build/broadcasts', label: 'Broadcasts', needs: ['artifacts:read'] },
      { path: '/build/campaigns', label: 'Campaigns', needs: ['artifacts:read'] },
      { path: '/build/forms', label: 'Forms', needs: ['artifacts:read'] },
      { path: '/build/segments', label: 'Segments', needs: ['artifacts:read'] },
      { path: '/build/experiences', label: 'Experiences', needs: ['artifacts:read'] },
      { path: '/build/prompts', label: 'AI prompts', needs: ['artifacts:read'] },
    ],
  },
  {
    key: 'design',
    label: 'Design',
    icon: Brush,
    items: [
      { path: '/design/templates', label: 'E-mail templates', needs: ['artifacts:read'] },
      { path: '/design/blocks', label: 'Blocks', needs: ['artifacts:read'] },
      { path: '/design/assets', label: 'Assets', needs: ['artifacts:read'] },
      { path: '/design/hosted-pages', label: 'Hosted pages', needs: ['artifacts:read'] },
      { path: '/design/brand', label: 'Brand', needs: ['artifacts:read'] },
    ],
  },
  {
    key: 'audience',
    label: 'Audience',
    icon: Users,
    items: [
      { path: '/audience/people', label: 'People', needs: ['profiles:read'] },
      { path: '/audience/consent', label: 'Consent', needs: ['profiles:read'] },
      { path: '/audience/imports', label: 'Imports', needs: ['profiles:write'] },
    ],
  },
  {
    key: 'insights',
    label: 'Insights',
    icon: BarChart3,
    items: [
      { path: '/insights/analytics', label: 'Analytics', needs: ['artifacts:read'] },
      { path: '/insights/messages', label: 'Messages', needs: ['profiles:read'] },
      { path: '/insights/deliverability', label: 'Deliverability', needs: ['artifacts:read'] },
      { path: '/insights/alerts', label: 'Alerts', needs: ['artifacts:read'] },
      { path: '/insights/journeys', label: 'Journey stats', needs: ['artifacts:read'] },
      { path: '/insights/ai', label: 'AI usage', needs: ['artifacts:read'] },
    ],
  },
  {
    key: 'approvals',
    label: 'Approvals',
    icon: CheckSquare,
    path: '/approvals',
    needs: ['artifacts:read'],
    items: [],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings,
    items: [
      { path: '/settings/providers', label: 'Providers', needs: ['workspace:admin'] },
      { path: '/settings/integrations', label: 'Integrations and API tokens', needs: [] },
      { path: '/settings/secrets', label: 'Secrets', needs: ['secrets:read'] },
      { path: '/settings/users', label: 'Users and roles', needs: ['workspace:admin'] },
      { path: '/settings/approval-policy', label: 'Approval policy', needs: ['artifacts:read'] },
      { path: '/settings/purposes', label: 'Purposes', needs: ['artifacts:read'] },
      { path: '/settings/workspace', label: 'Workspace', needs: ['workspace:admin'] },
      { path: '/settings/preferences', label: 'Preferences', needs: [] },
    ],
  },
];

export function visibleNav(can: (p: string) => boolean): NavGroup[] {
  const ok = (needs: string[] | undefined) => !needs?.length || needs.some(can);
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => ok(i.needs)) })).filter((g) => (g.path ? ok(g.needs) : g.items.length > 0));
}

/** The group and item for a path, for breadcrumbs and the active state. */
export function navFor(path: string): { group?: NavGroup; item?: NavItem } {
  for (const g of NAV) {
    if (g.path && (path === g.path || path.startsWith(`${g.path}/`))) return { group: g };
    for (const i of g.items) if (path === i.path || path.startsWith(`${i.path}/`)) return { group: g, item: i };
  }
  return {};
}

/** The first page a role can open, used for `/`. */
export function homePath(can: (p: string) => boolean): string {
  if (can('artifacts:approve')) return '/approvals';
  const first = visibleNav(can)[0];
  return first?.path ?? first?.items[0]?.path ?? '/settings/preferences';
}
