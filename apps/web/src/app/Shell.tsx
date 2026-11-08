import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useAutonomy } from '../features/agents/AutonomyProvider';
import { switchNotice } from '../features/agents/labels';
import { CopilotDrawer } from '../features/copilot/CopilotDrawer';
import { Badge, cx, IconButton, Kbd, Menu } from '../ui';
import { useFocusTrap } from '../ui/focus';
import { NewMenu } from './NewMenu';
import { type NavGroup, type NavItem, navFor, visibleNav } from './nav';
import { type Crumb, CrumbsProvider } from './page';
import { useCollapsedNavGroups, useNavPref } from './prefs';
import { Link, navigate, useLocation } from './router';
import { useSession } from './session';
import { THEME_ITEMS } from './ThemeMenu';
import { setThemePref, useThemePref } from './theme';

// The New brand wizard and the command palette are only needed when someone opens them, so they
// stay out of the shell bundle.
const NewBrandDrawer = lazy(async () => ({ default: (await import('../features/brand/NewBrandDrawer')).NewBrandDrawer }));
const SearchPalette = lazy(async () => ({ default: (await import('./SearchPalette')).SearchPalette }));

const isActive = (path: string, itemPath: string) =>
  itemPath === '/' ? path === '/' : path === itemPath || path.startsWith(`${itemPath}/`);

// The signed-in shell (DESIGN.md → Layout): a 232 px sidebar with collapsible work groups and Settings
// pinned at the bottom, a 56 px top bar with breadcrumbs, search, New and the account menu. Under
// 1024 px the sidebar becomes a 280 px drawer; on desktop it can collapse to a 64 px rail.
export function Shell({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [navPref, setNavPref] = useNavPref();
  const collapsed = navPref === 'collapsed';
  const { can } = useSession();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the mobile drawer closes on navigation, which the body does not read
  useEffect(() => setNavOpen(false), [path]);

  const openSearch = () => {
    window.dispatchEvent(new Event('am:close-menus'));
    setNavOpen(false);
    setCopilotOpen(false);
    setSearchOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        window.dispatchEvent(new Event('am:close-menus'));
        setNavOpen(false);
        setCopilotOpen(false);
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { group } = navFor(path);
  return (
    <div className="min-h-screen bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-2"
      >
        Skip to content
      </a>
      <aside
        id="app-sidebar"
        aria-label="Workspace"
        className={cx(
          'fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-surface transition-[width] duration-[var(--duration-enter)] ease-[var(--ease)] lg:block',
          collapsed ? 'w-16' : 'w-[232px]',
        )}
      >
        <Sidebar rail={collapsed} />
      </aside>
      {navOpen && <MobileNav onClose={() => setNavOpen(false)} />}
      <div
        className={cx(
          'min-w-0 transition-[padding-left] duration-[var(--duration-enter)] ease-[var(--ease)]',
          collapsed ? 'lg:pl-16' : 'lg:pl-[232px]',
        )}
      >
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-4 backdrop-blur-sm md:px-6 lg:px-8">
          <div className="lg:hidden">
            <IconButton label="Open navigation" icon={<MenuIcon size={18} />} onClick={() => setNavOpen(true)} />
          </div>
          <div className="hidden lg:block">
            <IconButton
              label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              onClick={() => setNavPref(collapsed ? 'expanded' : 'collapsed')}
            />
          </div>
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1 text-[13px]">
              {group && (
                <li className="hidden shrink-0 text-muted sm:block">
                  {group.key === 'settings' ? (
                    <Link to="/settings" className="hover:text-fg">
                      {group.label}
                    </Link>
                  ) : (
                    group.label
                  )}
                </li>
              )}
              {crumbs.map((c, i) => (
                <li key={c.to ?? c.label} className={cx('flex min-w-0 items-center gap-1', i < crumbs.length - 1 && 'hidden sm:flex')}>
                  {(group || i > 0) && (
                    <ChevronRight size={14} className={cx('shrink-0 text-muted', i === 0 && 'hidden sm:block')} aria-hidden />
                  )}
                  {c.to && i < crumbs.length - 1 ? (
                    <Link to={c.to} className="truncate text-muted hover:text-fg">
                      {c.label}
                    </Link>
                  ) : (
                    <span className="truncate font-medium text-fg" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                      {c.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="lg:hidden">
            <NewMenu variant="topbar" />
          </div>
          <AgentModeBadge />
          <button
            type="button"
            onClick={openSearch}
            className="hidden h-8 w-[240px] items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 text-[13px] text-muted hover:border-control md:flex xl:w-[280px]"
          >
            <Search size={14} aria-hidden />
            <span className="flex-1 text-left">Search or create…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <IconButton className="md:hidden" label="Search" icon={<Search size={16} />} onClick={openSearch} />
          {can('artifacts:read') && (
            <span className="hidden md:inline-flex">
              <IconButton
                label="Copilot"
                icon={<Bot size={16} />}
                onClick={() => {
                  window.dispatchEvent(new Event('am:close-menus'));
                  setSearchOpen(false);
                  setCopilotOpen(true);
                }}
              />
            </span>
          )}
          <UserMenu />
        </header>
        {/* The page, not the shell, decides its width (#114): see ui/layout.ts pageWidth(). */}
        <main id="main" tabIndex={-1} className="min-w-0 px-4 pt-6 pb-6 outline-none md:px-6 lg:px-8 lg:pt-8 lg:pb-8">
          <CrumbsProvider onChange={setCrumbs}>{children}</CrumbsProvider>
        </main>
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchPalette onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </div>
  );
}

/**
 * A standing reminder when the workspace is not fully on (#215): propose-only or off. It links to
 * the Agents work page so the person can see the agent settings that are paused.
 */
function AgentModeBadge() {
  const { settings } = useAutonomy();
  const notice = switchNotice(settings);
  if (!notice) return null;
  return (
    <Link
      to="/work/agents"
      aria-label={`${notice.label}. Change agent autonomy`}
      title={notice.label}
      className={cx(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium whitespace-nowrap md:h-7 md:px-2',
        notice.tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad',
      )}
    >
      <Bot size={13} aria-hidden />
      <span className="hidden sm:inline">{notice.label}</span>
    </Link>
  );
}

function MobileNav({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="am-fade-in absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="am-drawer-in absolute inset-y-0 left-0 w-[280px] max-w-[calc(100vw-48px)] border-r border-line bg-surface shadow-2"
      >
        <div className="absolute top-2 right-2">
          <IconButton label="Close navigation" icon={<X size={16} />} onClick={onClose} />
        </div>
        <Sidebar mobile />
      </div>
    </div>
  );
}

function Sidebar({ rail = false, mobile = false }: { rail?: boolean; mobile?: boolean }) {
  const { can, pending, user, workspace } = useSession();
  const { path } = useLocation();
  const groups = visibleNav(can);
  const active = navFor(path);
  const [collapsedGroups, setCollapsedGroups] = useCollapsedNavGroups(user?.id, workspace?.id);
  // Navigation expands the active group for this page view without rewriting the saved preference.
  const [autoOpen, setAutoOpen] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: expand on navigation only; toggling must not re-open
  useEffect(() => {
    if (active.group && collapsedGroups.includes(active.group.key)) setAutoOpen(active.group.key);
  }, [path, active.group?.key]);

  const openGroup = (group: NavGroup) => !collapsedGroups.includes(group.key) || autoOpen === group.key;
  const toggleGroup = (group: NavGroup) => {
    const open = openGroup(group);
    setAutoOpen((current) => (current === group.key ? null : current));
    setCollapsedGroups((current) => (open ? [...new Set([...current, group.key])] : current.filter((key) => key !== group.key)));
  };

  return (
    <div className="flex h-full flex-col">
      <WorkspaceSwitcher rail={rail} />
      {!mobile && (
        <div className={cx('pt-3', rail ? 'flex justify-center px-2' : 'px-2')}>
          <NewMenu variant={rail ? 'rail' : 'sidebar'} />
        </div>
      )}
      <nav aria-label="Main" className={cx('flex-1 overflow-y-auto pt-1 pb-4', rail ? 'px-1.5' : 'px-2')}>
        {rail ? (
          <RailNav groups={groups} path={path} pending={pending} />
        ) : (
          groups.map((group) => {
            const Icon = group.icon;
            const open = openGroup(group);
            return (
              <div key={group.key} className="mt-4">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`nav-group-${group.key}`}
                  onClick={() => toggleGroup(group)}
                  className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-[12px] leading-[18px] font-medium text-muted hover:bg-surface-2 hover:text-fg lg:h-7"
                >
                  <Icon size={14} aria-hidden />
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronDown size={14} aria-hidden className={cx('am-motion-transform', !open && '-rotate-90')} />
                </button>
                <ul id={`nav-group-${group.key}`} hidden={!open} className="mt-0.5 space-y-0.5">
                  {group.items.map((item) => {
                    const current = active.item?.path === item.path;
                    return (
                      <li key={item.path}>
                        <Link
                          to={item.path}
                          aria-current={current ? 'page' : undefined}
                          className={cx(
                            'flex h-10 items-center rounded-md pr-2 pl-[30px] text-[13px] pointer-coarse:h-10 lg:h-8',
                            current ? 'bg-accent-soft font-medium text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.path === '/approvals' && pending > 0 && (
                            <Badge tone="accent" label={`${pending} pending requests`}>
                              {pending}
                            </Badge>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </nav>
      <div className={cx('border-t border-line py-2', rail ? 'px-1.5' : 'px-2')}>
        <SettingsLink rail={rail} />
      </div>
    </div>
  );
}

function SettingsLink({ rail }: { rail: boolean }) {
  const { path } = useLocation();
  const current = path === '/settings' || path.startsWith('/settings/');
  return (
    <Link
      to="/settings"
      aria-current={current ? 'page' : undefined}
      aria-label="Settings"
      title="Settings"
      className={cx(
        'flex h-10 items-center gap-2 rounded-md text-[13px] pointer-coarse:h-10 lg:h-8',
        rail ? 'justify-center' : 'px-2',
        current ? 'bg-accent-soft font-medium text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      <SettingsIcon size={16} aria-hidden className={current ? '' : 'text-muted'} />
      {!rail && <span>Settings</span>}
    </Link>
  );
}

/**
 * The collapsed desktop navigation: a brand mark, New, the five work-group icons and Settings. Each
 * group icon opens a named popover of its permitted destinations; no group click navigates. The
 * active group is accent-soft, the active destination gets a check.
 */
function RailNav({ groups, path, pending }: { groups: NavGroup[]; path: string; pending: number }) {
  return (
    <ul className="mt-2 space-y-1">
      {groups.map((group) => {
        const Icon = group.icon;
        const active = group.items.some((item) => isActive(path, item.path));
        const itemClass = cx(
          'relative flex h-10 w-full items-center justify-center rounded-md',
          active ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        );
        const badge =
          group.items.some((item) => item.path === '/approvals') && pending > 0 ? (
            <span className="absolute top-1 right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-accent-fg">
              {pending}
            </span>
          ) : null;
        return (
          <li key={group.key}>
            <Menu
              label={`${group.label} navigation`}
              align="start"
              items={group.items.map((item: NavItem) => ({
                label: item.label,
                icon: isActive(path, item.path) ? <Check /> : undefined,
                onSelect: () => navigate(item.path),
              }))}
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  aria-label={`${group.label} navigation${badge ? `, ${pending} pending requests` : ''}`}
                  title={group.label}
                  className={itemClass}
                >
                  <Icon size={18} aria-hidden />
                  {badge}
                </button>
              )}
            />
          </li>
        );
      })}
    </ul>
  );
}

const roleLabel: Record<string, string> = { owner: 'Owner', admin: 'Admin', marketer: 'Builder', approver: 'Approver', viewer: 'Viewer' };
export const roleName = (r: string) => roleLabel[r] ?? r;

/**
 * The current brand's logo, contained in a fixed square (never stretched into a bar), or its
 * initial when no logo is published or the image fails to load (#438).
 */
function BrandMark({ logoUrl, name, className }: { logoUrl: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new logo URL must get a fresh chance to load
  useEffect(() => setFailed(false), [logoUrl]);
  const box = cx('flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-md border border-line', className);
  if (logoUrl && !failed)
    return (
      <span className={cx(box, 'bg-surface-2')}>
        <img src={logoUrl} alt="" className="size-full object-contain" onError={() => setFailed(true)} />
      </span>
    );
  return (
    <span aria-hidden className={cx(box, 'bg-surface-2 text-[12px] font-semibold text-fg-2')}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WorkspaceSwitcher({ rail = false }: { rail?: boolean }) {
  const { workspace, memberships, switchWorkspace } = useSession();
  const [newBrandOpen, setNewBrandOpen] = useState(false);
  const brand = workspace?.brand;
  const name = brand?.siteName ?? workspace?.name ?? '?';
  const domain = brand?.primaryDomain ?? null;
  // Anyone who owns at least one brand may create another; the server enforces the same rule.
  const canCreate = memberships.some((m) => m.role === 'owner');
  const others = memberships.filter((m) => m.id !== workspace?.id);
  const label = (
    <>
      <BrandMark logoUrl={brand?.logoUrl ?? null} name={name} className="size-7" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-semibold text-fg">{name}</span>{' '}
        <span className="block truncate text-[11px] text-muted">{domain ?? roleName(workspace?.you.role ?? '')}</span>
      </span>
    </>
  );
  const railLabel = <BrandMark logoUrl={brand?.logoUrl ?? null} name={name} className="size-8" />;
  const switcherItems = memberships.map((m) => ({
    label: (
      <span className="block min-w-0">
        <span className="block truncate font-medium text-fg">{m.brand.siteName}</span>
        <span className="block truncate text-[11px] text-muted">{m.brand.primaryDomain ?? roleName(m.role)}</span>
      </span>
    ),
    icon: m.id === workspace?.id ? <Check /> : <span className="inline-block size-4" />,
    onSelect: () => {
      if (m.id !== workspace?.id) {
        navigate('/');
        void switchWorkspace(m.id);
      }
    },
  }));
  const items = [
    ...switcherItems,
    ...(canCreate ? ['separator' as const, { label: 'New brand…', icon: <Plus />, onSelect: () => setNewBrandOpen(true) }] : []),
  ];
  if (!others.length && !canCreate)
    return (
      <div
        className={cx('flex items-center gap-2.5 border-b border-line', rail ? 'h-14 justify-center px-2' : 'h-14 px-3.5')}
        title={rail ? name : undefined}
      >
        {rail ? railLabel : label}
      </div>
    );
  return (
    <div className={cx('border-b border-line', rail ? 'flex h-14 items-center justify-center px-2' : 'p-2')}>
      <Menu
        align="start"
        label="Switch brand"
        items={items}
        trigger={(p) => (
          <button
            {...p}
            type="button"
            className={cx(
              'flex items-center rounded-md hover:bg-surface-2',
              rail ? 'size-10 justify-center' : 'h-10 w-full gap-2.5 px-1.5',
            )}
            // The visible brand name and role stay part of the accessible name (WCAG 2.5.3); the
            // hidden words add what the button does without replacing them.
            aria-label={rail ? `Brand: ${name}${domain ? ` (${domain})` : ''}. Switch brand` : undefined}
            title={rail ? name : undefined}
          >
            {rail ? (
              railLabel
            ) : (
              <>
                <span className="sr-only">Brand:</span> {label}
                <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="sr-only">{'. Switch brand'}</span>
              </>
            )}
          </button>
        )}
      />
      {newBrandOpen && (
        <Suspense fallback={null}>
          <NewBrandDrawer open onClose={() => setNewBrandOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, workspace, signOut } = useSession();
  const pref = useThemePref();
  const current = THEME_ITEMS.find((t) => t.key === pref)!;
  const initials = (user?.name || user?.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
  return (
    <Menu
      label="Account"
      header={
        <span className="block">
          <span className="block font-medium text-fg">{user?.name || 'Signed in'}</span>
          <span className="block text-[12px] text-muted">{user?.email}</span>
          <span className="block text-[12px] text-muted">{roleName(workspace?.you.role ?? '')}</span>
        </span>
      }
      items={[
        { label: 'Preferences', icon: <Settings2 />, onSelect: () => navigate('/preferences') },
        {
          label: `Theme: ${current.label}`,
          icon: current.icon,
          items: THEME_ITEMS.map((t) => ({
            label: t.label,
            icon: t.icon,
            hint: t.key === pref ? <Check size={14} /> : undefined,
            onSelect: () => setThemePref(t.key),
          })),
        },
        'separator',
        {
          label: 'Sign out',
          icon: <LogOut />,
          onSelect: () => {
            void signOut().then(() => navigate('/', { replace: true }));
          },
        },
      ]}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          className="ml-1 inline-flex size-10 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-fg-2 pointer-coarse:size-10 hover:bg-line-strong md:size-8"
        >
          {/* The initials stay visible; the full name is added as hidden text, so the accessible
              name contains the visible label (WCAG 2.5.3). */}
          <span className="sr-only">Account menu for {user?.name || user?.email}: </span>
          {initials}
        </button>
      )}
    />
  );
}
