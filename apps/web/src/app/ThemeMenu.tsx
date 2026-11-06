import { Check, Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Menu } from '../ui';
import { setThemePref, type ThemePref, useThemePref } from './theme';

/** The three theme choices, shared by the signed-out control and the account submenu. */
export const THEME_ITEMS: { key: ThemePref; label: string; icon: ReactNode }[] = [
  { key: 'system', label: 'System', icon: <Monitor /> },
  { key: 'light', label: 'Light', icon: <Sun /> },
  { key: 'dark', label: 'Dark', icon: <Moon /> },
];

/** The theme control used on the signed-out screens; signed-in people find it in the account menu. */
export function ThemeMenu() {
  const pref = useThemePref();
  const current = THEME_ITEMS.find((t) => t.key === pref)!;
  return (
    <Menu
      label="Theme"
      items={THEME_ITEMS.map((t) => ({
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
