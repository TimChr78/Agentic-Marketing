import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useAutonomy } from '../features/agents/AutonomyProvider';
import { switchNotice } from '../features/agents/labels';
import { CopilotDrawer } from '../features/copilot/CopilotDrawer';
import { Badge, cx, IconButton, Kbd, Menu } from '../ui';
import { useFocusTrap } from '../ui/focus';
import { navFor, visibleNav } from './nav';
import { type Crumb, CrumbsProvider } from './page';
import { useNavPref } from './prefs';
import { Link, navigate, useLocation } from './router';
import { SearchPalette } from './SearchPalette';
import { useSession } from './session';
import { setThemePref, type ThemePref, useThemePref } from './theme';

// The New brand wizard is only needed when someone opens it, so it stays out of the shell bundle.
const NewBrandDrawer = lazy(async () => ({ default: (await import('../features/brand/NewBrandDrawer')).NewBrandDrawer }));

// The signed-in shell (DESIGN.md → Layout): sidebar with the brand switcher and nav, top bar with
// breadcrumbs, search, theme and the user menu. Under 1024 px the sidebar becomes a drawer; on
// desktop it can collapse to a 64 px rail, remembered per person and device (#180).
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
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
          'fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-surface transition-[width] duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)] lg:block',
          collapsed ? 'w-16' : 'w-[232px]',
        )}
      >
        <Sidebar rail={collapsed} />
      </aside>
      {navOpen && <MobileNav onClose={() => setNavOpen(false)} />}
      <div
        className={cx(
          'min-w-0 transition-[padding-left] duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)]',
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
              {group && !group.path && <li className="hidden shrink-0 text-muted sm:block">{group.label}</li>}
              {crumbs.map((c, i) => (
                <li key={c.to ?? c.label} className={cx('flex min-w-0 items-center gap-1', i < crumbs.length - 1 && 'hidden sm:flex')}>
                  {((group && !group.path) || i > 0) && (
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
          <AgentModeBadge />
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden h-8 w-[240px] items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 text-[13px] text-muted hover:border-control md:flex xl:w-[280px]"
          >
            <Search size={14} aria-hidden />
            <span className="flex-1 text-left">Search</span>
            <Kbd>⌘K</Kbd>
          </button>
          <IconButton className="md:hidden" label="Search" icon={<Search size={16} />} onClick={() => setSearchOpen(true)} />
          {can('artifacts:read') && <IconButton label="Copilot" icon={<Bot size={16} />} onClick={() => setCopilotOpen(true)} />}
          <ThemeMenu />
          <UserMenu />
        </header>
        {/* The page, not the shell, decides its width (#114): see ui/layout.ts pageWidth(). */}
        <main id="main" tabIndex={-1} className="min-w-0 px-4 pt-6 pb-6 outline-none md:px-6 lg:px-8 lg:pt-8 lg:pb-8">
          <CrumbsProvider onChange={setCrumbs}>{children}</CrumbsProvider>
        </main>
      </div>
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </div>
  );
}

/**
 * A standing reminder when the workspace is not fully on (#215): propose-only or off. It links to
 * Settings → Agents so the person can see what is paused and switch it back.
 */
function AgentModeBadge() {
  const { settings } = useAutonomy();
  const notice = switchNotice(settings);
  if (!notice) return null;
  return (
    <Link
      to="/settings/agents"
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
        <Sidebar />
      </div>
    </div>
  );
}

function Sidebar({ rail = false }: { rail?: boolean }) {
  const { can, pending } = useSession();
  const { path } = useLocation();
  const groups = visibleNav(can);
  return (
    <div className="flex h-full flex-col">
      <WorkspaceSwitcher rail={rail} />
      <nav aria-label="Main" className={cx('flex-1 overflow-y-auto pb-4', rail ? 'px-1.5' : 'px-2')}>
        {rail ? (
          <RailNav groups={groups} path={path} pending={pending} />
        ) : (
          groups.map((g) => {
            const Icon = g.icon;
            if (g.path) {
              const active = path === g.path || path.startsWith(`${g.path}/`);
              return (
                <div key={g.key} className="mt-4">
                  <Link
                    to={g.path}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex h-10 items-center gap-2 rounded-md px-2 text-[13px] font-medium pointer-coarse:h-10 lg:h-8',
                      active ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <Icon size={16} aria-hidden className={active ? '' : 'text-muted'} />
                    <span className="flex-1">{g.label}</span>
                    {pending > 0 && (
                      <Badge tone="accent" label={`${pending} pending`}>
                        {pending}
                      </Badge>
                    )}
                  </Link>
                </div>
              );
            }
            return (
              <div key={g.key} className="mt-4">
                <div className="flex h-10 items-center gap-2 px-2 text-[12px] leading-[18px] font-medium text-muted lg:h-7">
                  <Icon size={14} aria-hidden />
                  {g.label}
                </div>
                <ul>
                  {g.items.map((i) => {
                    const active = path === i.path || path.startsWith(`${i.path}/`);
                    return (
                      <li key={i.path}>
                        <Link
                          to={i.path}
                          aria-current={active ? 'page' : undefined}
                          className={cx(
                            'flex h-10 items-center rounded-md pr-2 pl-[30px] text-[13px] pointer-coarse:h-10 lg:h-8',
                            active ? 'bg-accent-soft font-medium text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                          )}
                        >
                          {i.label}
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
    </div>
  );
}

/**
 * The collapsed desktop navigation (#180): group icons with a tooltip and accessible name, the
 * pending-approvals badge, and a menu with the group's pages so everything stays reachable without
 * expanding the rail. Under 1024 px the full sidebar is used instead.
 */
function RailNav({ groups, path, pending }: { groups: ReturnType<typeof visibleNav>; path: string; pending: number }) {
  return (
    <ul className="mt-2 space-y-1">
      {groups.map((g) => {
        const Icon = g.icon;
        const active = g.path
          ? path === g.path || path.startsWith(`${g.path}/`)
          : g.items.some((item) => path === item.path || path.startsWith(`${item.path}/`));
        const itemClass = cx(
          'relative flex h-10 w-full items-center justify-center rounded-md',
          active ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        );
        const badge =
          g.path === '/approvals' && pending > 0 ? (
            <span className="absolute top-1 right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-accent-fg">
              {pending}
            </span>
          ) : null;
        return (
          <li key={g.key}>
            {g.path ? (
              <Link
                to={g.path}
                aria-label={pending > 0 && g.path === '/approvals' ? `${g.label}, ${pending} pending` : g.label}
                title={g.label}
                aria-current={active ? 'page' : undefined}
                className={itemClass}
              >
                <Icon size={18} aria-hidden />
                {badge}
              </Link>
            ) : (
              <Menu
                label={g.label}
                align="start"
                items={g.items.map((item) => ({
                  label: item.label,
                  icon: path === item.path || path.startsWith(`${item.path}/`) ? <Check /> : undefined,
                  onSelect: () => navigate(item.path),
                }))}
                trigger={(p) => (
                  <button {...p} type="button" aria-label={`${g.label} navigation`} title={g.label} className={itemClass}>
                    <Icon size={18} aria-hidden />
                  </button>
                )}
              />
            )}
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

const themeItems: { key: ThemePref; label: string; icon: ReactNode }[] = [
  { key: 'system', label: 'System', icon: <Monitor /> },
  { key: 'light', label: 'Light', icon: <Sun /> },
  { key: 'dark', label: 'Dark', icon: <Moon /> },
];

export function ThemeMenu() {
  const pref = useThemePref();
  const current = themeItems.find((t) => t.key === pref)!;
  return (
    <Menu
      label="Theme"
      items={themeItems.map((t) => ({
        label: t.label,
        icon: t.icon,
        hint: t.key === pref ? <Check size={14} /> : undefined,
        onSelect: () => setThemePref(t.key),
      }))}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label={`Theme: ${current.label}`}
          title={`Theme: ${current.label}`}
          className="inline-flex size-10 items-center justify-center rounded-md text-fg-2 pointer-coarse:size-10 hover:bg-surface-2 hover:text-fg md:size-8 [&_svg]:size-4"
        >
          {current.icon}
        </button>
      )}
    />
  );
}

function UserMenu() {
  const { user, signOut } = useSession();
  const initials = (user?.name || user?.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
  return (
    <Menu
      label="Account"
      items={[
        {
          label: (
            <span className="block">
              <span className="block font-medium">{user?.name || 'Signed in'}</span>
              <span className="block text-[12px] text-muted">{user?.email}</span>
            </span>
          ),
          onSelect: () => navigate('/settings/preferences'),
        },
        'separator',
        { label: 'Preferences', icon: <Settings2 />, onSelect: () => navigate('/settings/preferences') },
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
