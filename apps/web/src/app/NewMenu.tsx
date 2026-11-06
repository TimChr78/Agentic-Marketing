import { Plus } from 'lucide-react';
import { cx, Menu } from '../ui';
import { CREATE_ACTIONS, STARTER_ACTION } from './createIntent';
import { navigate } from './router';
import { useSession } from './session';

/**
 * The global New menu (#446): exact order, existing create flows only, and shown only with
 * artifacts:write. Selecting an item navigates to the canonical family list with `?create=<type>`;
 * no mutation happens from the menu itself. “From a starter…” is the create gallery.
 */
export function NewMenu({ variant }: { variant: 'sidebar' | 'rail' | 'topbar' }) {
  const { can } = useSession();
  if (!can('artifacts:write')) return null;

  const StarterIcon = STARTER_ACTION.icon;
  const items = [
    ...CREATE_ACTIONS.map((action) => {
      const Icon = action.icon;
      return {
        label: action.label,
        icon: <Icon />,
        onSelect: () => navigate(action.to),
      };
    }),
    'separator' as const,
    {
      label: STARTER_ACTION.label,
      icon: <StarterIcon />,
      onSelect: () => navigate(STARTER_ACTION.to),
    },
  ];

  return (
    <Menu
      label="New"
      align="start"
      items={items}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label="New"
          title="New"
          className={cx(
            'inline-flex items-center justify-center gap-2 rounded-md bg-accent font-medium text-accent-fg transition-colors hover:bg-accent-hover [&_svg]:size-4',
            variant === 'sidebar' ? 'h-10 w-full px-2.5 text-[13px]' : 'size-10 shrink-0',
          )}
        >
          <Plus aria-hidden />
          {variant === 'sidebar' && <span>New</span>}
        </button>
      )}
    />
  );
}
