import {
  Bell,
  Bot,
  BriefcaseBusiness,
  Building2,
  Cable,
  ChartNoAxesCombined,
  CheckSquare,
  ClipboardList,
  Files,
  HeartPulse,
  House,
  Image as ImageIcon,
  KeyRound,
  ListFilter,
  type LucideIcon,
  Mail,
  Mails,
  Megaphone,
  Palette,
  PanelsTopLeft,
  Plug,
  Send,
  Settings,
  ShieldCheck,
  Target,
  Users,
  UsersRound,
  Workflow,
} from 'lucide-react';

// The Phase 24 information architecture (#446, docs/design/phase-24/shell-navigation.md): find work,
// start an existing creation flow and recover old bookmarks. Each entry names the permissions that
// show it; entries the person cannot use are hidden, so the nav never leads to a page full of 403s.
//
// Every path here is canonical. Legacy URLs live in redirects.ts and are never linked from the UI.

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these permissions shows the entry. Empty: everyone in the workspace. */
  needs: string[];
}
export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /** A destination for the group itself (Settings is the only one); work groups have none. */
  path?: string;
  items: NavItem[];
}

const ANYONE: string[] = [];

export const NAV: NavGroup[] = [
  {
    key: 'work',
    label: 'Work',
    icon: BriefcaseBusiness,
    items: [
      { path: '/', label: 'Home', icon: House, needs: ANYONE },
      { path: '/approvals', label: 'Approvals', icon: CheckSquare, needs: ['artifacts:read'] },
      { path: '/work/agents', label: 'Agents', icon: Bot, needs: ['artifacts:read'] },
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    icon: Megaphone,
    items: [
      { path: '/marketing/campaigns', label: 'Campaigns', icon: Target, needs: ['artifacts:read'] },
      { path: '/marketing/broadcasts', label: 'Broadcasts', icon: Send, needs: ['artifacts:read'] },
      { path: '/marketing/journeys', label: 'Journeys', icon: Workflow, needs: ['artifacts:read'] },
      { path: '/marketing/experiences', label: 'Web experiences', icon: PanelsTopLeft, needs: ['artifacts:read'] },
    ],
  },
  {
    key: 'audience',
    label: 'Audience',
    icon: Users,
    items: [
      { path: '/audience/people', label: 'People', icon: Users, needs: ['profiles:read'] },
      { path: '/audience/segments', label: 'Segments', icon: ListFilter, needs: ['artifacts:read'] },
      { path: '/audience/forms', label: 'Forms', icon: ClipboardList, needs: ['artifacts:read'] },
      // The union preserves Topics/Purposes access for artifacts-only roles; each tab keeps its gate.
      { path: '/audience/consent', label: 'Consent', icon: ShieldCheck, needs: ['profiles:read', 'artifacts:read'] },
    ],
  },
  {
    key: 'content',
    label: 'Content',
    icon: Files,
    items: [
      { path: '/content/templates', label: 'Templates', icon: Mail, needs: ['artifacts:read'] },
      { path: '/content/assets', label: 'Assets', icon: ImageIcon, needs: ['artifacts:read'] },
      { path: '/content/brand', label: 'Brand', icon: Palette, needs: ['artifacts:read'] },
    ],
  },
  {
    key: 'insights',
    label: 'Insights',
    icon: ChartNoAxesCombined,
    items: [
      { path: '/insights/analytics', label: 'Analytics', icon: ChartNoAxesCombined, needs: ['artifacts:read'] },
      { path: '/insights/messages', label: 'Message activity', icon: Mails, needs: ['profiles:read'] },
      { path: '/insights/deliverability', label: 'Deliverability', icon: HeartPulse, needs: ['artifacts:read'] },
      { path: '/insights/alerts', label: 'Alerts', icon: Bell, needs: ['artifacts:read'] },
    ],
  },
];

/**
 * Settings is pinned at the bottom of the shell, outside the collapsible work groups. Its children
 * are the secondary navigation (`ui/SettingsLayout.tsx`); they never appear in the main nav.
 */
export const SETTINGS_GROUP: NavGroup = {
  key: 'settings',
  label: 'Settings',
  path: '/settings',
  icon: Settings,
  items: [
    { path: '/settings/workspace', label: 'Workspace', icon: Building2, needs: ['workspace:admin'] },
    { path: '/settings/providers', label: 'Providers', icon: Plug, needs: ['workspace:admin'] },
    { path: '/settings/integrations', label: 'Integrations and API tokens', icon: Cable, needs: ANYONE },
    { path: '/settings/secrets', label: 'Secrets', icon: KeyRound, needs: ['secrets:read'] },
    { path: '/settings/users', label: 'Users and roles', icon: UsersRound, needs: ['workspace:admin'] },
    {
      path: '/settings/approval-policy',
      label: 'Approval policy and agent autonomy',
      icon: ShieldCheck,
      needs: ['artifacts:read'],
    },
  ],
};

export const SETTINGS_ITEMS = SETTINGS_GROUP.items;

const permitted = (needs: string[] | undefined, can: (p: string) => boolean) => !needs?.length || needs.some(can);

/** The work groups this role can use, with empty groups removed. */
export function visibleNav(can: (p: string) => boolean): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => permitted(i.needs, can)) })).filter((g) => g.items.length > 0);
}

/** The Settings secondary items this role can open. */
export function visibleSettings(can: (p: string) => boolean): NavItem[] {
  return SETTINGS_ITEMS.filter((i) => permitted(i.needs, can));
}

/** The first page a role can open in Settings; Integrations is the fallback everyone reaches. */
export function settingsPath(can: (p: string) => boolean): string {
  return visibleSettings(can)[0]?.path ?? '/settings/integrations';
}

const matches = (itemPath: string, path: string) =>
  itemPath === '/' ? path === '/' : path === itemPath || path.startsWith(`${itemPath}/`);

/**
 * The group and item for a path, for breadcrumbs and the active state. Item prefix matching chooses
 * the longest path, so `/work/agents/library/:id` stays under Agents rather than an arbitrary sibling.
 */
export function navFor(path: string): { group?: NavGroup; item?: NavItem } {
  let best: { group: NavGroup; item: NavItem } | undefined;
  for (const group of [...NAV, SETTINGS_GROUP]) {
    for (const item of group.items) {
      if (!matches(item.path, path)) continue;
      if (!best || item.path.length > best.item.path.length) best = { group, item };
    }
  }
  if (best) return best;
  if (path === '/settings') return { group: SETTINGS_GROUP };
  return {};
}

/** The first main destination for a role. `/` itself is Home for every signed-in member. */
export function homePath(_can: (p: string) => boolean): string {
  return '/';
}
