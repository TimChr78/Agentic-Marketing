import { Bot, Check, ChevronDown, ChevronRight, LogOut, Menu as MenuIcon, Monitor, Moon, Search, Settings2, Sun, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CopilotDrawer } from '../features/copilot/CopilotDrawer';
import { Badge, cx, IconButton, Kbd, Menu } from '../ui';
import { useFocusTrap } from '../ui/focus';
import { navFor, visibleNav } from './nav';
import { type Crumb, CrumbsProvider } from './page';
import { Link, navigate, useLocation } from './router';
import { SearchPalette } from './SearchPalette';
import { useSession } from './session';
import { setThemePref, type ThemePref, useThemePref } from './theme';

// The signed-in shell (DESIGN.md → Layout): sidebar with the workspace switcher and nav, top bar
// with breadcrumbs, search, theme and the user menu. Under 1024 px the sidebar becomes a drawer.

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const { can } = useSession();

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
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {navOpen && <MobileNav onClose={() => setNavOpen(false)} />}
      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur-sm sm:px-5">
          <IconButton className="lg:hidden" label="Open navigation" icon={<MenuIcon size={18} />} onClick={() => setNavOpen(true)} />
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1 text-[13px]">
              {group && !group.path && <li className="hidden shrink-0 text-muted sm:block">{group.label}</li>}
              {crumbs.map((c, i) => (
                <li key={i} className={cx('flex min-w-0 items-center gap-1', i < crumbs.length - 1 && 'hidden sm:flex')}>
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
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden h-8 w-[240px] items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 text-[13px] text-muted hover:border-control md:flex"
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
        <main id="main" tabIndex={-1} className="w-full px-4 py-6 outline-none sm:px-6 lg:px-8">
          <CrumbsProvider onChange={setCrumbs}>{children}</CrumbsProvider>
        </main>
      </div>
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </div>
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
        className="am-drawer-in absolute inset-y-0 left-0 w-[272px] max-w-[85vw] border-r border-line bg-surface shadow-2"
      >
        <div className="absolute top-2 right-2">
          <IconButton label="Close navigation" icon={<X size={16} />} onClick={onClose} />
        </div>
        <Sidebar />
      </div>
    </div>
  );
}

function Sidebar() {
  const { can, pending } = useSession();
  const { path } = useLocation();
  const groups = visibleNav(can);
  return (
    <div className="flex h-full flex-col">
      <WorkspaceSwitcher />
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.map((g) => {
          const Icon = g.icon;
          if (g.path) {
            const active = path === g.path || path.startsWith(`${g.path}/`);
            return (
              <div key={g.key} className="mt-4">
                <Link
                  to={g.path}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium',
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
              <div className="flex h-7 items-center gap-2 px-2 text-[12px] font-medium text-muted">
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
                          'flex h-8 items-center rounded-md pr-2 pl-[30px] text-[13px]',
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
        })}
      </nav>
    </div>
  );
}

const roleLabel: Record<string, string> = { owner: 'Owner', admin: 'Admin', marketer: 'Builder', approver: 'Approver', viewer: 'Viewer' };
export const roleName = (r: string) => roleLabel[r] ?? r;

function WorkspaceSwitcher() {
  const { workspace, memberships, switchWorkspace } = useSession();
  const others = memberships.filter((m) => m.id !== workspace?.id);
  const label = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-fg text-[12px] font-semibold text-bg" aria-hidden>
        {(workspace?.name ?? '?').slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-semibold text-fg">{workspace?.name}</span>
        <span className="block truncate text-[11px] text-muted">{roleName(workspace?.you.role ?? '')}</span>
      </span>
    </>
  );
  if (!others.length) return <div className="flex h-14 items-center gap-2.5 border-b border-line px-3.5">{label}</div>;
  return (
    <div className="border-b border-line p-2">
      <Menu
        align="start"
        label="Switch workspace"
        items={memberships.map((m) => ({
          label: `${m.name} · ${roleName(m.role)}`,
          icon: m.id === workspace?.id ? <Check /> : <span className="inline-block size-4" />,
          onSelect: () => {
            if (m.id !== workspace?.id) {
              navigate('/');
              void switchWorkspace(m.id);
            }
          },
        }))}
        trigger={(p) => (
          <button
            {...p}
            type="button"
            className="flex h-10 w-full items-center gap-2.5 rounded-md px-1.5 hover:bg-surface-2"
            aria-label={`Workspace: ${workspace?.name}. Switch workspace`}
          >
            {label}
            <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden />
          </button>
        )}
      />
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
          className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg [&_svg]:size-4"
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
          aria-label={`Account: ${user?.name || user?.email}`}
          className="ml-1 inline-flex size-8 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-fg-2 hover:bg-line-strong"
        >
          {initials}
        </button>
      )}
    />
  );
}
