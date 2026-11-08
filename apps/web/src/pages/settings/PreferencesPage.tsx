import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { setThemePref, type ThemePref, useThemePref } from '../../app/theme';
import { usePageTab } from '../../app/useTab';
import { roleLabel } from '../../features/settings/roles';
import { LoadingBlock, Meta, Mono, RadioCards, Tag } from '../../ui';
import { DetailPage } from '../../ui/DetailPage';

const THEME_OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follows your device setting.' },
  { value: 'light', label: 'Light', hint: 'Always light.' },
  { value: 'dark', label: 'Dark', hint: 'Always dark.' },
];

const TABS = ['appearance', 'account', 'permissions'] as const;

/**
 * Your preferences: the theme on this device, your account, and what your role allows. Permission
 * meanings come first; the technical codes stay behind an advanced disclosure.
 */
export default function PreferencesPage() {
  useCrumbs([{ label: 'Preferences' }]);
  const { user, workspace } = useWorkspace();
  const theme = useThemePref();
  const { active, select } = usePageTab({ keys: TABS, fallback: 'appearance' });
  const explained = workspace.permissionsExplained;

  return (
    <DetailPage
      title="Preferences"
      kind="Account"
      state="ready"
      loadingContent={<LoadingBlock lines={3} label="Opening your preferences" />}
      metadata={<span>Your appearance on this device, and what your account and role allow.</span>}
      activeTab={active}
      onTabChange={(key) => select(key as (typeof TABS)[number])}
      consequence={
        <p className="rounded-lg bg-surface-2 px-4 py-3 text-[13px] leading-5 text-fg-2">
          Appearance is kept for you on this device. Your account, workspace and role come from this workspace and cannot be changed here.
        </p>
      }
      tabs={[
        {
          key: 'appearance',
          label: 'Appearance',
          panel: (
            <div className="max-w-[560px] space-y-3">
              <p className="text-[13px] text-muted">Kept for you on this device.</p>
              <RadioCards name="theme" value={theme} onChange={setThemePref} options={THEME_OPTIONS} />
            </div>
          ),
        },
        {
          key: 'account',
          label: 'Account',
          panel: (
            <div className="max-w-[560px] space-y-3">
              <p className="text-[13px] text-muted">You are signed in to this workspace.</p>
              <Meta
                items={[
                  [
                    'Signed in as',
                    <span key="signed-in">
                      <span className="font-medium text-fg">{user.name || 'No name'}</span> <span className="text-muted">{user.email}</span>
                    </span>,
                  ],
                  ['Workspace', workspace.name],
                  ['Role', <Tag key="role">{roleLabel(workspace.you.role)}</Tag>],
                ]}
              />
            </div>
          ),
        },
        {
          key: 'permissions',
          label: 'What you can do',
          panel: (
            <div className="max-w-[640px]">
              <p className="mb-3 text-[13px] text-muted">Your permissions in this workspace, and what each one allows.</p>
              {explained.length ? (
                <ul className="divide-y divide-line">
                  {explained.map(({ permission, meaning }) => (
                    <li key={permission} className="py-3">
                      <p className="text-[13px] leading-5 text-fg">{meaning}</p>
                      <details className="mt-1 text-[12px] leading-[18px] text-muted">
                        <summary className="cursor-pointer hover:text-fg">Technical permission name</summary>
                        <p className="mt-1">
                          <Mono>{permission}</Mono>
                        </p>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No permissions are listed for this account.</p>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
