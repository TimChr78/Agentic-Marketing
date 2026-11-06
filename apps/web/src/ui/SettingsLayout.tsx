import type { ReactNode } from 'react';
import { SETTINGS_GROUP, visibleSettings } from '../app/nav';
import { Link, navigate, useLocation } from '../app/router';
import { useSession } from '../app/session';
import { cx, Field, Select } from '.';
import { pageWidth } from './layout';

/**
 * Settings' own secondary navigation (#446): 200 px left column + 24 gap + 760 body at 1440, and a
 * native labelled section select above the body below 1024. The main navigation has no Settings
 * children. Every explicit child still has its route gate, so a deep link to a denied section
 * explains it instead of rendering the page.
 */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const { can } = useSession();
  const { path } = useLocation();
  const items = visibleSettings(can);
  const active = items.find((i) => path === i.path || path.startsWith(`${i.path}/`)) ?? items[0];

  return (
    <div className={pageWidth('default')}>
      <div className="lg:grid lg:grid-cols-[200px_minmax(0,760px)] lg:gap-6">
        <nav aria-label={SETTINGS_GROUP.label} className="hidden lg:block">
          <ul className="space-y-2">
            {items.map((item) => {
              const Icon = item.icon;
              const current = item.path === active?.path;
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    aria-current={current ? 'page' : undefined}
                    className={cx(
                      'flex min-h-9 items-center gap-2 rounded-md px-2 text-[13px] leading-5',
                      current ? 'bg-accent-soft font-medium text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <Icon size={16} aria-hidden className={current ? '' : 'text-muted'} />
                    <span className="min-w-0">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mb-5 lg:hidden">
          <Field label="Settings section">
            <Select value={active?.path ?? ''} onChange={(e) => navigate(e.target.value)}>
              {items.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="min-w-0 max-w-[760px]">{children}</div>
      </div>
    </div>
  );
}
